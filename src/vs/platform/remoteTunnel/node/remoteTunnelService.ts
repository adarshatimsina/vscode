/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRemoteTunnelAccount, IRemoteTunnelService } from 'vs/platform/remoteTunnel/common/remoteTunnel';
import { Emitter } from 'vs/base/common/event';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { Disposable } from 'vs/base/common/lifecycle';
import { ILogger, ILoggerService } from 'vs/platform/log/common/log';
import { URI } from 'vs/base/common/uri';
import { dirname, join } from 'vs/base/common/path';
import { ChildProcess, spawn } from 'child_process';
import { IProductService } from 'vs/platform/product/common/productService';
import { isWindows } from 'vs/base/common/platform';
import { CancelablePromise, createCancelablePromise } from 'vs/base/common/async';


type RemoteTunnelEnablementClassification = {
	owner: 'aeschli';
	comment: 'Reporting when Machine Sharing is turned on or off';
	enabled?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Flag indicating if machine sharing is enabled or not' };
};

type RemoteTunnelEnablementEvent = {
	enabled: boolean;
};

/**
 * This service runs on the shared service. It is running the `code-tunnel` command
 * to make the current machine available for remote access.
 */
export class RemoteTunnelService extends Disposable implements IRemoteTunnelService {

	declare readonly _serviceBrand: undefined;

	private readonly _onTokenFailedEmitter = new Emitter<boolean>();
	public readonly onTokenFailed = this._onTokenFailedEmitter.event;

	private readonly _onTunnelFailedEmitter = new Emitter<void>();
	public readonly onTunnelFailed = this._onTunnelFailedEmitter.event;

	private readonly _onDidChangeAccountEmitter = new Emitter<IRemoteTunnelAccount | undefined>();
	public readonly onDidChangeAccount = this._onDidChangeAccountEmitter.event;

	private readonly _logger: ILogger;

	private _account: IRemoteTunnelAccount | undefined;

	private _tunnelProcess: CancelablePromise<void> | undefined;

	constructor(
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IProductService private readonly productService: IProductService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ILoggerService loggerService: ILoggerService,
	) {
		super();
		const logFileUri = URI.file(join(dirname(environmentService.logsPath), 'remoteTunnel.log'));
		this._logger = this._register(loggerService.createLogger(logFileUri, { name: 'remoteTunnel' }));
	}

	override dispose(): void {
		this._logger.info('disposed');
		console.log('xxxx disposed');
		if (this._tunnelProcess) {
			this._tunnelProcess.cancel();
			this._tunnelProcess = undefined;
		}
		this._logger.flush();
		super.dispose();
	}

	async getAccount(): Promise<IRemoteTunnelAccount | undefined> {
		return this._account;
	}

	async updateAccount(account: IRemoteTunnelAccount | undefined): Promise<void> {
		console.log('updateAccount');
		if (account && this._account ? account.token !== this._account.token || account.authenticationProviderId !== this._account.authenticationProviderId : account !== this._account) {
			this._account = account;
			this._onDidChangeAccountEmitter.fire(account);

			this._logger.info(`Account updated: ${account ? account.authenticationProviderId : 'undefined'}`);

			this.telemetryService.publicLog2<RemoteTunnelEnablementEvent, RemoteTunnelEnablementClassification>('remoteTunnel.enablement', { enabled: !!account });

			try {
				this.updateTunnelProcess();
			} catch (e) {
				this._logger.error(e);
			}
		}

	}

	private async updateTunnelProcess(): Promise<void> {
		if (this._tunnelProcess) {
			this._tunnelProcess.cancel();
			this._tunnelProcess = undefined;
		}
		if (!this._account) {
			return;
		}
		const loginProcess = this.runCodeTunneCommand('login', 'tunnel', 'user', 'login', '--provider', this._account.authenticationProviderId, '--access-token', this._account.token);
		this._tunnelProcess = loginProcess;
		try {
			await loginProcess;
		} catch (e) {
			this._logger.error(e);
			this._tunnelProcess = undefined;
			this._onTokenFailedEmitter.fire(true);
		}
		if (this._tunnelProcess === loginProcess) {
			const serveCommand = this.runCodeTunneCommand('tunnel', 'tunnel');
			this._tunnelProcess = serveCommand;
			serveCommand.finally(() => {
				if (serveCommand === this._tunnelProcess) {
					// process exited unexpectedly
					this._logger.info(`tunnel process terminated`);
					this._tunnelProcess = undefined;
					this._account = undefined;

					this._onTunnelFailedEmitter.fire();
				}
			});

		}
	}

	private runCodeTunneCommand(logLabel: string, ...commandArgs: string[]): CancelablePromise<void> {
		return createCancelablePromise<void>(token => {
			return new Promise((resolve, reject) => {
				if (token.isCancellationRequested) {
					resolve();
				}
				let tunnelProcess: ChildProcess | undefined;
				token.onCancellationRequested(() => {
					if (tunnelProcess) {
						this._logger.info(`${logLabel} terminating (${tunnelProcess.pid})`);
						tunnelProcess.kill();
					}
				});
				if (process.env['VSCODE_DEV']) {
					this._logger.info(`${logLabel} Spawning: cargo run -- ${commandArgs.join(' ')}`);
					tunnelProcess = spawn('cargo', ['run', '--', ...commandArgs], { cwd: join(this.environmentService.appRoot, 'cli') });
				} else {
					const tunnelCommand = join(dirname(process.execPath), 'bin', `${this.productService.tunnelApplicationName}${isWindows ? '.exe' : ''}`);
					this._logger.info(`${logLabel} Spawning: ${tunnelCommand} ${commandArgs.join(' ')}`);
					tunnelProcess = spawn(tunnelCommand, commandArgs);
				}

				tunnelProcess.stdout!.on('data', data => {
					if (tunnelProcess) {
						this._logger.info(`${logLabel} stdout (${tunnelProcess.pid}):  + ${data.toString()}`);
					}
				});
				tunnelProcess.stderr!.on('data', data => {
					if (tunnelProcess) {
						this._logger.info(`${logLabel} stderr (${tunnelProcess.pid}):  + ${data.toString()}`);
					}
				});
				tunnelProcess.on('exit', e => {
					if (tunnelProcess) {
						this._logger.info(`${logLabel} exit (${tunnelProcess.pid}):  + ${e}`);
						tunnelProcess = undefined;
						resolve();
					}
				});
				tunnelProcess.on('error', e => {
					if (tunnelProcess) {
						this._logger.info(`${logLabel} error (${tunnelProcess.pid}):  + ${e}`);
						tunnelProcess = undefined;
						reject();
					}
				});
			});
		});
	}

}