// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>


import assert from 'assert';
import * as Tp from 'thingpedia';
import AsyncQueue from 'consumer-queue';

import { Replaceable, ReplacedConcatenation, ReplacedResult } from '../utils/template-string';
import type Engine from '../engine';
import * as ParserClient from '../prediction/parserclient';
import * as I18n from '../i18n';

import ValueCategory from './value-category';
import QueueItem from './dialogue_queue';
import { UserInput, } from './user-input';
import { PlatformData } from './protocol';
import { CancellationError } from './errors';

import type Conversation from './conversation';
import AppExecutor from '../engine/apps/app_executor';
import DeviceInterfaceMapper from '../engine/devices/device_interface_mapper';

import ExecutionDialogueAgent from '../thingtalk-dialogues/inference-thingtalk-executor';
import { InferenceTimeDialogue as ThingTalkDialogueHandler } from '../thingtalk-dialogues/inference-time-dialogue';

import FAQDialogueHandler from './handlers/faq';
import ThingpediaDialogueHandler from './handlers/3rdparty';
import DeviceView from '../engine/devices/device_view';
import { LogLevel } from '../sentence-generator/runtime';


export enum CommandAnalysisType {
    // special commands - these are generated by the exact matcher, or
    // by UI buttons like the "X" button
    STOP,
    DEBUG,

    // some sort of command
    CONFIDENT_IN_DOMAIN_COMMAND,
    NONCONFIDENT_IN_DOMAIN_COMMAND,
    CONFIDENT_IN_DOMAIN_FOLLOWUP,
    NONCONFIDENT_IN_DOMAIN_FOLLOWUP,
    OUT_OF_DOMAIN_COMMAND,
}

const enum Confidence {
    NO,
    MAYBE,
    YES
}

export interface CommandAnalysisResult {
    type : CommandAnalysisType;
    // used in the conversation logs
    utterance : string;
    user_target : string;
}

// TODO move link messages to FormattedObject as well
export type ReplyMessage = string|Tp.FormatObjects.FormattedObject|{
    type : 'link',
    title : string,
    url : string
}

export interface ReplyResult {
    messages : ReplyMessage[];
    expecting : ValueCategory|null;
    end : boolean;

    // used in the conversation logs
    context : string;
    agent_target : string;
}

export interface DialogueHandler<AnalysisType extends CommandAnalysisResult, StateType> {
    priority : Tp.DialogueHandler.Priority;
    uniqueId : string;
    icon : string|null;

    initialize(initialState : StateType|undefined, showWelcome : boolean) : Promise<ReplyResult|null>;
    getState() : StateType;
    reset() : void;

    analyzeCommand(command : UserInput) : Promise<AnalysisType>;
    getReply(command : AnalysisType) : Promise<ReplyResult>;
}

export class DialogueLoop {
    conversation : Conversation;
    engine : Engine;

    private _langPack : I18n.LanguagePack;
    private _userInputQueue : AsyncQueue<UserInput>;
    private _notifyQueue : AsyncQueue<QueueItem>;
    private _debug : boolean;
    private _agent : ExecutionDialogueAgent;
    private _nlu : ParserClient.ParserClient;
    private _nlg : ParserClient.ParserClient;
    private _thingtalkHandler : ThingTalkDialogueHandler;
    private _faqHandlers : Record<string, FAQDialogueHandler>;
    private _dynamicHandlers : DeviceInterfaceMapper<DialogueHandler<CommandAnalysisResult, any>>;
    private _currentHandler : DialogueHandler<CommandAnalysisResult, any>|null;

    private icon : string|null;
    expecting : ValueCategory|null;
    platformData : PlatformData;
    choices : string[];
    raw = false;

    private _stopped = false;
    private _mgrResolve : (() => void)|null;
    private _mgrPromise : Promise<void>|null;

    constructor(conversation : Conversation,
                engine : Engine,
                options : {
                    nluServerUrl : string|undefined;
                    nlgServerUrl : string|undefined;
                    policy : string|undefined;
                    debug : boolean;
                    faqModels : Record<string, {
                        url : string;
                        highConfidence ?: number;
                        lowConfidence ?: number;
                    }>
                }) {
        this._userInputQueue = new AsyncQueue();
        this._notifyQueue = new AsyncQueue();

        this._debug = options.debug;
        this.conversation = conversation;
        this.engine = engine;
        this._langPack = I18n.get(engine.platform.locale);
        this._agent = new ExecutionDialogueAgent(engine, conversation, options.debug);
        this._nlu = ParserClient.get(options.nluServerUrl || undefined, engine.platform.locale, engine.platform,
            undefined, engine.thingpedia);
        this._nlg = ParserClient.get(options.nlgServerUrl || undefined, engine.platform.locale, engine.platform);
        this._thingtalkHandler = new ThingTalkDialogueHandler({
            thingpediaClient: engine.thingpedia,
            schemaRetriever: engine.schemas,
            locale: engine.platform.locale,
            timezone: engine.platform.timezone,
            policy: options.policy,
            executor: this._agent,
            nlu: this._nlu,
            nlg: this._nlg,
            extraFlags: {},
            anonymous: conversation.isAnonymous,
            debug: options.debug ? LogLevel.DUMP_TEMPLATES : LogLevel.INFO,
            rng: Math.random
        });
        this._faqHandlers = {};
        for (const faq in options.faqModels)
            this._faqHandlers[faq] = new FAQDialogueHandler(this, faq, options.faqModels[faq], { locale: engine.platform.locale });
        this._dynamicHandlers = new DeviceInterfaceMapper(new DeviceView(engine.devices, 'org.thingpedia.dialogue-handler', {}),
            (device) => new ThingpediaDialogueHandler(device));
        this._currentHandler = null;

        this.icon = null;
        this.expecting = null;
        this.choices = [];
        this.platformData = {};

        this._mgrResolve = null;
        this._mgrPromise = null;
    }

    get _() : (x : string) => string {
        return this.conversation._;
    }
    get isAnonymous() : boolean {
        return this.conversation.isAnonymous;
    }
    get hasDebug() : boolean {
        return this._debug;
    }

    getState() : Record<string, unknown> {
        const state : Record<string, unknown> = {};
        for (const handler of this._iterateDialogueHandlers())
            state[handler.uniqueId] = handler.getState();
        return state;
    }

    debug(...args : unknown[]) {
        if (!this._debug)
            return;
        console.log(...args);
    }

    interpolate(msg : string, args : Record<string, unknown>) : string {
        const replacements = [];
        const names = [];
        for (const key in args) {
            names.push(key);
            const value = args[key];
            if (value !== null && value !== undefined) {
                replacements.push({
                    text: value instanceof ReplacedResult ? value : new ReplacedConcatenation([String(value)], {}, {}),
                    value,
                });
            } else {
                replacements.push(undefined);
            }
        }

        const tmpl = Replaceable.get(msg, this._langPack, names);
        return this._langPack.postprocessNLG(tmpl.replace({ replacements, constraints: {} })!.chooseBest(), {}, this._agent);
    }

    private _formatError(error : Error|string) {
        if (typeof error === 'string')
            return error;
        else if (error.name === 'SyntaxError')
            return this.interpolate(this._("Syntax error {at ${error.fileName}|} {line ${error.lineNumber}|}: ${error.message}"), { error });
        else if (error.message)
            return error.message;
        else
            return String(error);
    }

    async nextCommand() : Promise<UserInput> {
        await this.conversation.sendAskSpecial();
        this._mgrPromise = null;
        this._mgrResolve!();
        const intent = await this._userInputQueue.pop();
        this.platformData = intent.platformData;
        return intent;
    }

    private *_iterateDialogueHandlers() {
        yield this._thingtalkHandler;

        for (const key in this._faqHandlers)
            yield this._faqHandlers[key];

        yield* this._dynamicHandlers.values();
    }

    private async _analyzeCommand(command : UserInput) : Promise<[DialogueHandler<any, any>|undefined, CommandAnalysisResult]> {
        try {
            let best : DialogueHandler<any, any>|undefined, bestanalysis : CommandAnalysisResult|undefined;
            let bestconfidence = Confidence.NO;

            // This algorithm will choose the dialogue handlers that reports:
            // - the highest confidence
            // - if a tie, the highest priority
            // - if a tie, the current handler
            // - if a tie, the first handler that reports any confidence at all

            for (const handler of this._iterateDialogueHandlers()) {
                const analysis = await handler.analyzeCommand(command);

                this.debug(`Handler ${handler.uniqueId} reports ${CommandAnalysisType[analysis.type]}`);

                switch (analysis.type) {
                case CommandAnalysisType.STOP:
                case CommandAnalysisType.DEBUG:
                case CommandAnalysisType.CONFIDENT_IN_DOMAIN_COMMAND:
                    // choose if either
                    // - we're higher priority
                    // - we're more confident
                    // - we're the current dialogue and we have the same priority
                    if (best === undefined ||
                        handler.priority > best.priority ||
                        bestconfidence < Confidence.YES ||
                        (this._currentHandler === handler &&
                         handler.priority >= best.priority)) {
                        best = handler;
                        bestanalysis = analysis;
                        bestconfidence = Confidence.YES;
                    }
                    break;

                case CommandAnalysisType.NONCONFIDENT_IN_DOMAIN_COMMAND:
                    // choose if both:
                    // - we're higher priority (same if we're the current dialogue)
                    // - we're as confident
                    if (best === undefined ||
                        ((handler.priority > best.priority ||
                         (this._currentHandler === handler &&
                         handler.priority >= best.priority)) &&
                        bestconfidence <= Confidence.MAYBE)) {
                        best = handler;
                        bestanalysis = analysis;
                        bestconfidence = Confidence.MAYBE;
                    }
                    break;

                case CommandAnalysisType.CONFIDENT_IN_DOMAIN_FOLLOWUP:
                    // choose if handler is the current handler and either
                    // - we're same priority
                    // - we're more confident
                    if (this._currentHandler === handler &&
                        (best === undefined ||
                         handler.priority >= best.priority ||
                         bestconfidence < Confidence.YES)) {
                        best = handler;
                        bestanalysis = analysis;
                        bestconfidence = Confidence.YES;
                    }
                    break;

                case CommandAnalysisType.NONCONFIDENT_IN_DOMAIN_FOLLOWUP:
                    // choose if handler is the current handler and either
                    // - we're same priority
                    // - we're as confident
                    if (this._currentHandler === handler &&
                        (best === undefined ||
                         (handler.priority >= best.priority &&
                          bestconfidence <= Confidence.MAYBE))) {
                        best = handler;
                        bestanalysis = analysis;
                        bestconfidence = Confidence.YES;
                    }
                    break;

                default:
                    // ignore this handler, which decided the command is out of domain
                }
            }

            return [best, bestanalysis || {
                type: CommandAnalysisType.OUT_OF_DOMAIN_COMMAND,
                utterance: command.type === 'command' ? command.utterance : command.parsed.prettyprint(),
                user_target: '$failed;',
            }];
        } catch(e) {
            if (e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT') {
                await this.reply(this._("Sorry, I cannot contact the Genie service. Please check your Internet connection and try again later."), null);
                throw new CancellationError();
            } else if (typeof e.code === 'number' && (e.code === 404 || e.code >= 500)) {
                await this.reply(this._("Sorry, there seems to be a problem with the Genie service at the moment. Please try again later."), null);
                throw new CancellationError();
            } else {
                throw e;
            }
        }
    }

    private async _handleUICommand(type : CommandAnalysisType) {
        switch (type) {
        case CommandAnalysisType.STOP:
            // stop means cancel, but without a failure message + stopping audio
            if (this.engine.audio)
                await this.engine.audio.stopAudio();
            throw new CancellationError();

        case CommandAnalysisType.DEBUG:
            await this.reply("Current State:\n");
            for (const handler of this._iterateDialogueHandlers())
                await this.reply(handler.uniqueId + ': ' + handler.getState());
            break;
        }
    }

    private async _handleAPICall(call : QueueItem) {
        if (call instanceof QueueItem.Notification)
            await this._sendAgentReply(await this._thingtalkHandler.showNotification(call.app.program, call.app.name, call.outputType, call.outputValue));
        else if (call instanceof QueueItem.Error)
            await this._sendAgentReply(await this._thingtalkHandler.showAsyncError(call.app.program, call.app.name, call.error));
    }

    private async _sendAgentReply(reply : ReplyResult) {
        this.conversation.updateLog('context', reply.context);
        this.conversation.updateLog('agent_target', reply.agent_target);

        for (const msg of reply.messages)
            await this.replyGeneric(msg);

        await this.setExpected(reply.expecting);
    }

    private async _handleUserInput(command : UserInput) {
        for (;;) {
            const [handler, analysis] = await this._analyzeCommand(command);
            // save the utterance and complete the turn
            // skip the log if the command was ignored
            this.conversation.updateLog('user', analysis.utterance);
            this.conversation.updateLog('user_target', analysis.user_target);
            await this.conversation.turnFinished();

            if (!handler) {
                await this.fail();
                return;
            }

            if (analysis.type === CommandAnalysisType.STOP ||
                analysis.type === CommandAnalysisType.DEBUG) {
                await this._handleUICommand(analysis.type);
                command = await this.nextCommand();
                continue;
            }

            this._currentHandler = handler;
            const reply = await handler.getReply(analysis);
            this.icon = handler.icon;
            await this._sendAgentReply(reply);

            // if we're not expecting any more answer from the user,
            // exit this loop
            // note: this does not mean the dialogue is terminated!
            // state is preserved until we call reset() due to context reset
            // timeout, or some command causes a CancellationError
            // (typically, "never mind", or a "no" in sys_anything_else)
            //
            // exiting this loop means that we close the microphone
            // (requiring a wakeword again to continue) and start
            // processing notifications again

            if (reply.end)
                throw new CancellationError();
            if (this.expecting === null)
                return;
            command = await this.nextCommand();
        }
    }

    private async _initialize(showWelcome : boolean, initialState : Record<string, unknown>|null) {
        let bestreply : ReplyResult|undefined, bestpriority = -1;
        for (const handler of this._iterateDialogueHandlers()) {
            const reply = await handler.initialize(initialState ? initialState[handler.uniqueId] : undefined, showWelcome);
            if (reply !== null && handler.priority > bestpriority) {
                bestpriority = handler.priority;
                bestreply = reply;
            }
        }

        if (bestreply)
            await this._sendAgentReply(bestreply);
        else
            await this.setExpected(null);
    }

    private async _loop(showWelcome : boolean, initialState : Record<string, unknown>|null) {
        await this._initialize(showWelcome, initialState);

        while (!this._stopped) {
            let item;
            try {
                item = await this.nextQueueItem();
                if (item instanceof QueueItem.UserInput)
                    await this._handleUserInput(item.command);
                else
                    await this._handleAPICall(item);
            } catch(e) {
                if (e.code === 'ECANCELLED') {
                    for (const handler of this._iterateDialogueHandlers())
                        handler.reset();
                    this._currentHandler = null;
                    this.icon = null;
                    await this.setExpected(null);
                    // if the dialogue terminated, save the last utterance from the agent
                    // in a new turn with an empty utterance from the user
                    await this.conversation.dialogueFinished();
                } else {
                    if (item instanceof QueueItem.UserInput) {
                        await this.replyInterp(this._("Sorry, I had an error processing your command: ${error}."), {//"
                            error: this._formatError(e)
                        });
                    } else {
                        await this.replyInterp(this._("Sorry, that did not work: ${error}."), {
                            error: this._formatError(e)
                        });
                    }
                    console.error(e);
                }
            }
        }
    }

    async nextQueueItem() : Promise<QueueItem> {
        await this.conversation.sendAskSpecial();
        this._mgrPromise = null;
        this._mgrResolve!();
        const queueItem = await this._notifyQueue.pop();
        if (queueItem instanceof QueueItem.UserInput)
            this.platformData = queueItem.command.platformData;
        else
            this.platformData = {};
        return queueItem;
    }
    async fail(msg ?: string) {
        if (msg) {
            await this.replyInterp(this._("Sorry, I did not understand that: ${error}. Can you rephrase it?"), {
                error: msg
            });
        } else {
            await this.reply(this._("Sorry, I did not understand that. Can you rephrase it?"));
        }
        throw new CancellationError();
    }

    setExpected(expected : ValueCategory|null, raw = (expected === ValueCategory.RawString || expected === ValueCategory.Password)) {
        if (expected === undefined)
            throw new TypeError();
        this.expecting = expected;
        this.raw = raw;
        const [contextCode, contextEntities] = this._thingtalkHandler.prepareContextForPrediction();
        this.conversation.setExpected(expected, { code: contextCode, entities: contextEntities });
    }

    async replyInterp(msg : string, args ?: Record<string, unknown>, icon : string|null = null) {
        if (args === undefined)
            return this.reply(msg, icon);
        else
            return this.reply(this.interpolate(msg, args), icon);
    }

    async reply(msg : string, icon ?: string|null) {
        this.conversation.updateLog('agent', msg);
        await this.conversation.sendReply(msg, icon || this.icon);
    }

    async replyGeneric(message : ReplyMessage, icon ?: string|null) {
        if (typeof message === 'string')
            await this.reply(message, icon);
        else if (message.type === 'text')
            await this.reply(message.text, icon);
        else if (message.type === 'picture' || message.type === 'audio' || message.type === 'video')
            await this.conversation.sendMedia(message.type, message.url, message.alt, icon || this.icon);
        else if (message.type === 'rdl')
            await this.conversation.sendRDL(message, icon || this.icon);
        else if (message.type === 'sound')
            await this.conversation.sendSoundEffect(message.name, message.exclusive, icon || this.icon);
        else if (message.type === 'button')
            await this.conversation.sendButton(message.title, message.json);
        else if (message.type === 'link')
            await this.conversation.sendLink(message.title, message.url, this.conversation.getState());
    }

    private _isInDefaultState() : boolean {
        return this._notifyQueue.hasWaiter();
    }

    dispatchNotify(app : AppExecutor, outputType : string, outputValue : Record<string, unknown>) {
        const item = new QueueItem.Notification(app, outputType, outputValue);
        this._pushQueueItem(item);
    }
    dispatchNotifyError(app : AppExecutor, error : Error) {
        const item = new QueueItem.Error(app, error);
        this._pushQueueItem(item);
    }

    async start(showWelcome : boolean, initialState : Record<string, unknown>|null) {
        await this._nlu.start();
        await this._nlg.start();
        this._dynamicHandlers.start();

        const promise = this._waitNextCommand();
        this._loop(showWelcome, initialState).then(() => {
            throw new Error('Unexpected end of dialog loop');
        }, (err) => {
            console.error('Uncaught error in dialog loop', err);
            throw err;
        });
        return promise;
    }

    async stop() {
        this._stopped = true;

        // wait until the dialog is ready to accept commands, then inject
        // a cancellation error
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        if (this._isInDefaultState())
            this._notifyQueue.cancelWait(new CancellationError());
        else
            this._userInputQueue.cancelWait(new CancellationError());

        this._dynamicHandlers.stop();
        await this._nlu.stop();
        await this._nlg.stop();
    }

    async reset() {
        // wait until the dialog is ready to accept commands
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        if (this._isInDefaultState())
            this._notifyQueue.cancelWait(new CancellationError());
        else
            this._userInputQueue.cancelWait(new CancellationError());
    }

    private _pushQueueItem(item : QueueItem) {
        // ensure that we have something to wait on before the next
        // command is handled
        if (!this._mgrPromise)
            this._waitNextCommand();

        this._notifyQueue.push(item);
    }

    /**
     * Returns a promise that will resolve when the dialogue loop is
     * ready to accept the next command from the user.
     */
    private _waitNextCommand() : Promise<void> {
        const promise = new Promise<void>((callback, errback) => {
            this._mgrResolve = callback;
        });
        this._mgrPromise = promise;
        return promise;
    }

    pushCommand(command : UserInput) {
        this._pushQueueItem(new QueueItem.UserInput(command));
    }

    async handleCommand(command : UserInput) : Promise<void> {
        // wait until the dialog is ready to accept commands
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        const promise = this._waitNextCommand();

        if (this._isInDefaultState())
            this.pushCommand(command);
        else
            this._userInputQueue.push(command);

        return promise;
    }
}
