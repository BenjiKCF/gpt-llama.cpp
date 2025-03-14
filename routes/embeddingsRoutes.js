import express from 'express';
import { exec, spawn } from 'child_process';
import { join } from 'path';
import { readFile, writeFile } from 'fs';
import {
	stripAnsiCodes,
	getLlamaPath,
	getModelPath,
	dataToEmbeddingResponse,
} from '../utils.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Embeddings
 *   description: Creates an embedding vector representing the input text.
 * /v1/embeddings:
 *   post:
 *     summary: Creates an embedding vector representing the input text.
 *     tags:
 *       - Embeddings
 *     description: Creates an embedding vector representing the input text.
 *     requestBody:
 *       description: Object containing inputs for generating an embedding
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               model:
 *                 type: string
 *                 description: The ID of the LLM model to use for generating completions (this currently makes no difference)
 *               input:
 *                 type: string or array
 *                 description: Input text to get embeddings for, encoded as a string or array of tokens. To get embeddings for multiple inputs in a single request, pass an array of strings or array of token arrays. Each input must not exceed 8192 tokens in length.
 *     responses:
 *       '200':
 *         description: A response object containing the generated embedding vector
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 choices:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       message:
 *                         type: object
 *                         properties:
 *                           content:
 *                             type: string
 *                             description: The generated embeddings text
 *                           metadata:
 *                             type: object
 *                             description: Additional metadata about the completion
 */

router.post('/', async (req, res) => {
	global.serverBusy = true;
	console.log(`\n=====  EMBEDDING REQUEST  =====`);

	!!global.childProcess && global.childProcess.kill('SIGINT'); // kill previous childprocess
	console.log(process.env.EMBEDDINGS)
	const input = Array.isArray(req.body.input)
	? req.body.input.join(' ')
	: req.body.input;
	const useLlamaEmbeddings = process.env.EMBEDDINGS || 'llama'; // py for python extension for embeddings
	if (useLlamaEmbeddings == 'py') {
		console.log(`\n=====  PYTHON EMBEDDING EXTENSION SPAWNED  =====`);
		const scriptPath = join(
			process.cwd(),
			'extensions',
			'embeddings',
			'main.py'
		);
		const scriptOutput = join(
			process.cwd(),
			'extensions',
			'embeddings',
			'output.txt'
		);
		const scriptInput = join(
			process.cwd(),
			'extensions',
			'embeddings',
			'input.txt'
		);
		writeFile(scriptInput, input, (err) => {
			if (err) throw err;
			exec(
				`python ${scriptPath} ${scriptInput} > ${scriptOutput}`,
				async (error) => {
					if (error) {
						console.error(`exec error: ${error}`);
						return;
					}

					readFile(scriptOutput, 'utf8', (err, data) => {
						if (err) {
							console.error(`Error reading file: ${err}`);
							return;
						}

						!!global.childProcess && global.childProcess.kill('SIGINT');
						const dataArr = data.split(',').map((d) => parseFloat(d));
						const promptTokens = dataArr.length;

						// Embedding Size = 768
						res
							.status(200)
							.json(dataToEmbeddingResponse(dataArr, promptTokens));
						console.log(dataToEmbeddingResponse(dataArr, promptTokens));
						console.log('Embedding Request DONE');
						global.serverBusy = false;
					});
				}
			);
		});
	} else {
		const modelId = req.body.model; // TODO: Implement model somehow
		const llamaPath = getLlamaPath(req, res);
		const modelPath = getModelPath(req, res);
		const scriptPath = join(llamaPath, 'embedding');

		if (!modelPath) {
			return res.status(500).send('re-run Herd with MODEL= variable set.');
		}

		const scriptArgs = ['-m', modelPath, '-p', input.replace(/"/g, '\\"')];
		const promptTokens = Math.ceil(input.length / 4);
		// LLAMA OUTPUT
		global.childProcess = spawn(scriptPath, scriptArgs);
		console.log(`\n=====  LLAMA.CPP SPAWNED  =====`);
		console.log(`${scriptPath} ${scriptArgs.join(' ')}\n`);
		console.log(`\n=====  REQUEST  =====\n${input}`);

		const stdoutStream = global.childProcess.stdout;
		let outputString = '';
		let output = [];
		const readable = new ReadableStream({
			start(controller) {
				const decoder = new TextDecoder();
				const onData = (chunk) => {
					const data = stripAnsiCodes(decoder.decode(chunk));
					outputString += data;
				};

				const onClose = () => {
					global.childProcess.kill('SIGINT');
					output = outputString.split(' ').flatMap((d) => {
						const validFloatRegex = /^[-+]?[0-9]*\.?[0-9]+$/;
						return validFloatRegex.test(d) ? parseFloat(d) : [];
					});
					// See llama model embedding sizes: https://huggingface.co/shalomma/llama-7b-embeddings#quantitative-analysis
					res.status(200).json(dataToEmbeddingResponse(output, promptTokens));
					console.log(dataToEmbeddingResponse(output, promptTokens));
					controller.close();
					console.log('Embedding Request DONE');
					global.serverBusy = false;
				};

				const onError = (error) => {
					console.log('Readable Stream: ERROR');
					console.log(error);
					controller.error(error);
				};

				stdoutStream.on('data', onData);
				stdoutStream.on('close', onClose);
				stdoutStream.on('error', onError);
			},
		});
	}
});

export default router;
