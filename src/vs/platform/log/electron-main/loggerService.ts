/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResourceMap } from 'vs/base/common/map';
import { URI } from 'vs/base/common/uri';
import { Event } from 'vs/base/common/event';
import { refineServiceDecorator } from 'vs/platform/instantiation/common/instantiation';
import { DidChangeLoggersEvent, ILoggerResource, ILoggerService, LogLevel, isLogLevel } from 'vs/platform/log/common/log';
import { LoggerService } from 'vs/platform/log/node/loggerService';

export const ILoggerMainService = refineServiceDecorator<ILoggerService, ILoggerMainService>(ILoggerService);

export interface ILoggerMainService extends ILoggerService {

	getOnDidChangeLogLevelEvent(windowId: number): Event<LogLevel | [URI, LogLevel]>;

	getOnDidChangeVisibilityEvent(windowId: number): Event<[URI, boolean]>;

	getOnDidChangeLoggersEvent(windowId: number): Event<DidChangeLoggersEvent>;

	registerLogger(resource: ILoggerResource, windowId?: number): void;

	getRegisteredLoggers(windowId?: number): ILoggerResource[];

	deregisterLoggers(windowId: number): void;

}

export class LoggerMainService extends LoggerService implements ILoggerMainService {

	private readonly loggerResourcesByWindow = new ResourceMap<number>();

	override registerLogger(resource: ILoggerResource, windowId?: number): void {
		if (windowId !== undefined) {
			this.loggerResourcesByWindow.set(resource.resource, windowId);
		}
		super.registerLogger(resource);
	}

	override deregisterLogger(resource: URI): void {
		this.loggerResourcesByWindow.delete(resource);
		super.deregisterLogger(resource);
	}

	override getRegisteredLoggers(windowId?: number): ILoggerResource[] {
		const resources: ILoggerResource[] = [];
		for (const resource of super.getRegisteredLoggers()) {
			if (this.isInterestedLoggerResource(resource.resource, windowId)) {
				resources.push(resource);
			}
		}
		return resources;
	}

	getOnDidChangeLogLevelEvent(windowId: number): Event<LogLevel | [URI, LogLevel]> {
		return Event.filter(this.onDidChangeLogLevel, arg => isLogLevel(arg) || this.isInterestedLoggerResource(arg[0], windowId));
	}

	getOnDidChangeVisibilityEvent(windowId: number): Event<[URI, boolean]> {
		return Event.filter(this.onDidChangeVisibility, ([resource]) => this.isInterestedLoggerResource(resource, windowId));
	}

	getOnDidChangeLoggersEvent(windowId: number): Event<DidChangeLoggersEvent> {
		return Event.filter(
			Event.map(this.onDidChangeLoggers, e => {
				const r = {
					added: [...e.added].filter(loggerResource => this.isInterestedLoggerResource(loggerResource.resource, windowId)),
					removed: [...e.removed].filter(loggerResource => this.isInterestedLoggerResource(loggerResource.resource, windowId)),
				};
				return r;
			}), e => e.added.length > 0 || e.removed.length > 0);
	}

	deregisterLoggers(windowId: number): void {
		for (const [resource, resourceWindow] of this.loggerResourcesByWindow) {
			if (resourceWindow === windowId) {
				this.deregisterLogger(resource);
			}
		}
	}

	private isInterestedLoggerResource(resource: URI, windowId: number | undefined): boolean {
		const loggerWindowId = this.loggerResourcesByWindow.get(resource);
		return loggerWindowId === undefined || loggerWindowId === windowId;
	}

	override dispose(): void {
		super.dispose();
		this.loggerResourcesByWindow.clear();
	}
}

