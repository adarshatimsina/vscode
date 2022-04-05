/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as playwright from '@playwright/test';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { mkdir } from 'fs';
import { promisify } from 'util';
import { IDriver, IDisposable } from './driver';
import { URI } from 'vscode-uri';
import * as kill from 'tree-kill';
import { Logger, measureAndLog } from './logger';
import type { LaunchOptions } from './code';
import { PlaywrightDriver } from './playwrightDriver';

const root = join(__dirname, '..', '..', '..');

let port = 9000;

export async function launch(options: LaunchOptions): Promise<{ serverProcess: ChildProcess; client: IDisposable; driver: IDriver; kill: () => Promise<void> }> {

	// Launch server
	const { serverProcess, endpoint } = await launchServer(options);

	// Launch browser
	const { browser, context, page } = await launchBrowser(options, endpoint);

	return {
		serverProcess,
		client: {
			dispose: () => { /* there is no client to dispose for browser, teardown is triggered via exitApplication call */ }
		},
		driver: new PlaywrightDriver(browser, context, page, serverProcess.pid, options),
		kill: () => teardown(serverProcess.pid, options.logger)
	};
}

async function launchServer(options: LaunchOptions) {
	const { userDataDir, codePath, extensionsPath, logger, logsPath } = options;
	const codeServerPath = codePath ?? process.env.VSCODE_REMOTE_SERVER_PATH;
	const agentFolder = userDataDir;
	await measureAndLog(promisify(mkdir)(agentFolder), `mkdir(${agentFolder})`, logger);
	const env = {
		VSCODE_REMOTE_SERVER_PATH: codeServerPath,
		...process.env
	};

	const args = ['--disable-telemetry', '--disable-workspace-trust', '--port', `${port++}`, '--driver', 'web', '--extensions-dir', extensionsPath, '--server-data-dir', agentFolder, '--accept-server-license-terms'];

	let serverLocation: string | undefined;
	if (codeServerPath) {
		const { serverApplicationName } = require(join(codeServerPath, 'product.json'));
		serverLocation = join(codeServerPath, 'bin', `${serverApplicationName}${process.platform === 'win32' ? '.cmd' : ''}`);

		logger.log(`Starting built server from '${serverLocation}'`);
	} else {
		serverLocation = join(root, `scripts/code-server.${process.platform === 'win32' ? 'bat' : 'sh'}`);

		logger.log(`Starting server out of sources from '${serverLocation}'`);
	}

	logger.log(`Storing log files into '${logsPath}'`);
	args.push('--logsPath', logsPath);

	logger.log(`Command line: '${serverLocation}' ${args.join(' ')}`);
	const serverProcess = spawn(
		serverLocation,
		args,
		{ env }
	);

	logger.log(`Started server for browser smoke tests (pid: ${serverProcess.pid})`);

	return {
		serverProcess,
		endpoint: await measureAndLog(waitForEndpoint(serverProcess, logger), 'waitForEndpoint(serverProcess)', logger)
	};
}

async function launchBrowser(options: LaunchOptions, endpoint: string) {
	const { logger, workspacePath, tracing, headless } = options;

	const browser = await measureAndLog(playwright[options.browser ?? 'chromium'].launch({ headless: headless ?? false }), 'playwright#launch', logger);
	browser.on('disconnected', () => logger.log(`Playwright: browser disconnected`));

	const context = await measureAndLog(browser.newContext(), 'browser.newContext', logger);

	if (tracing) {
		try {
			await measureAndLog(context.tracing.start({ screenshots: true, /* remaining options are off for perf reasons */ }), 'context.tracing.start()', logger);
		} catch (error) {
			logger.log(`Playwright (Browser): Failed to start playwright tracing (${error})`); // do not fail the build when this fails
		}
	}

	const page = await measureAndLog(context.newPage(), 'context.newPage()', logger);
	await measureAndLog(page.setViewportSize({ width: 1200, height: 800 }), 'page.setViewportSize', logger);

	if (options.verbose) {
		context.on('page', () => logger.log(`Playwright (Browser): context.on('page')`));
		context.on('requestfailed', e => logger.log(`Playwright (Browser): context.on('requestfailed') [${e.failure()?.errorText} for ${e.url()}]`));

		page.on('console', e => logger.log(`Playwright (Browser): window.on('console') [${e.text()}]`));
		page.on('dialog', () => logger.log(`Playwright (Browser): page.on('dialog')`));
		page.on('domcontentloaded', () => logger.log(`Playwright (Browser): page.on('domcontentloaded')`));
		page.on('load', () => logger.log(`Playwright (Browser): page.on('load')`));
		page.on('popup', () => logger.log(`Playwright (Browser): page.on('popup')`));
		page.on('framenavigated', () => logger.log(`Playwright (Browser): page.on('framenavigated')`));
		page.on('requestfailed', e => logger.log(`Playwright (Browser): page.on('requestfailed') [${e.failure()?.errorText} for ${e.url()}]`));
	}

	page.on('pageerror', async (error) => logger.log(`Playwright (Browser) ERROR: page error: ${error}`));
	page.on('crash', () => logger.log('Playwright (Browser) ERROR: page crash'));
	page.on('close', () => logger.log('Playwright (Browser): page close'));
	page.on('response', async (response) => {
		if (response.status() >= 400) {
			logger.log(`Playwright (Browser) ERROR: HTTP status ${response.status()} for ${response.url()}`);
		}
	});

	const payloadParam = `[["enableProposedApi",""],["webviewExternalEndpointCommit","181b43c0e2949e36ecb623d8cc6de29d4fa2bae8"],["skipWelcome","true"]]`;
	await measureAndLog(page.goto(`${endpoint}&${workspacePath.endsWith('.code-workspace') ? 'workspace' : 'folder'}=${URI.file(workspacePath!).path}&payload=${payloadParam}`), 'page.goto()', logger);

	return { browser, context, page };
}

export async function teardown(serverPid: number | undefined, logger: Logger): Promise<void> {
	if (typeof serverPid !== 'number') {
		return;
	}

	let retries = 0;
	while (retries < 3) {
		retries++;

		try {
			return await promisify(kill)(serverPid);
		} catch (error) {
			try {
				process.kill(serverPid, 0); // throws an exception if the process doesn't exist anymore
				logger.log(`Error tearing down server (pid: ${serverPid}, attempt: ${retries}): ${error}`);
			} catch (error) {
				return; // Expected when process is gone
			}
		}
	}

	logger.log(`Gave up tearing down server after ${retries} attempts...`);
}

function waitForEndpoint(server: ChildProcess, logger: Logger): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let endpointFound = false;

		server.stdout?.on('data', data => {
			if (!endpointFound) {
				logger.log(`[server] stdout: ${data}`); // log until endpoint found to diagnose issues
			}

			const matches = data.toString('ascii').match(/Web UI available at (.+)/);
			if (matches !== null) {
				endpointFound = true;

				resolve(matches[1]);
			}
		});

		server.stderr?.on('data', error => {
			if (!endpointFound) {
				logger.log(`[server] stderr: ${error}`); // log until endpoint found to diagnose issues
			}

			if (error.toString().indexOf('EADDRINUSE') !== -1) {
				reject(new Error(error));
			}
		});
	});
}