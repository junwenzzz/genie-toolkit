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
import * as ThingTalk from 'thingtalk';
import { Ast, Type } from 'thingtalk';

import type Engine from '../engine';
import type { DeviceInfo } from '../engine';

import ValueCategory from './value-category';
import StatementExecutor from './statement_executor';
import { CancellationError } from './errors';
import * as Helpers from './helpers';
import type DialogueLoop from './dialogue-loop';
import { EntityRecord } from './entity-linking/entity-finder';
import { Contact } from './entity-linking/contact_search';

import AbstractDialogueAgent, {
    DisambiguationHints,
} from './abstract_dialogue_agent';

/**
 * The execution time dialogue agent.
 *
 * Provides access to the real user's information, stored in the engine.
 */
export default class ExecutionDialogueAgent extends AbstractDialogueAgent<undefined> {
    private _engine : Engine;
    private _thingpedia : Tp.BaseClient;
    private _platform : Tp.BasePlatform;
    private _dlg : DialogueLoop;
    private _executor : StatementExecutor;

    constructor(engine : Engine, dlg : DialogueLoop, debug : boolean) {
        super(engine.schemas, {
            debug: debug,
            locale: engine.platform.locale,
            timezone: engine.platform.timezone
        });

        this._engine = engine;
        this._thingpedia = engine.thingpedia;
        this._platform = engine.platform;
        this._executor = new StatementExecutor(engine);
        this._dlg = dlg;
    }

    get _() {
        return this._dlg._;
    }
    get executor() {
        return this._executor;
    }

    getAllDevicesOfKind(kind : string) {
        return this._engine.getDeviceInfos(kind);
    }

    async disambiguate(type : 'device'|'contact',
                       name : string|null,
                       choices : string[],
                       hint ?: string) : Promise<number> {
        let question : string;
        if (type === 'device') {
            question = this._dlg.interpolate(this._("You have multiple ${?“${name}” }${device} devices. Which one do you want to use?"), {
                name,
                device: Helpers.cleanKind(hint!)
            })!;
        } else {
            question = this._dlg.interpolate(this._("Multiple contacts match “${name}”. Who do you mean?"), { name })!;
        }
        return this._dlg.askChoices(question, choices);
    }

    protected async tryConfigureDevice(kind : string) : Promise<DeviceInfo> {
        const factories = await this._thingpedia.getDeviceSetup([kind]);
        const factory = factories[kind];
        if (factory && factory.type === 'none') {
            const device = await this._engine.createDevice({ kind: factory.kind });
            return this._engine.getDeviceInfo(device.uniqueId!);
        } else {
            this._dlg.icon = null;
            if (this._dlg.isAnonymous) {
                await this._dlg.reply(this._("Sorry, I did not understand that. You might need to enable a new skill before I understand that command. To do so, please log in to your personal account."));
                await this._dlg.replyLink(this._("Register for Almond"), "/user/register");
            } else {
                await this._dlg.reply(this._("Sorry, I did not understand that. You might need to enable a new skill before I understand that command."));
                await this._dlg.replyLink(this._("Configure a new skill"), "/devices/create");
            }
            throw new CancellationError(); // cancel the dialogue if we failed to set up a device
        }
    }

    async lookupContact(category : ValueCategory, name : string) : Promise<Contact[]> {
        if (this._dlg.platformData.contacts) {
            for (const platformContact of this._dlg.platformData.contacts) {
                if (platformContact.value === name) {
                    this.debug(`Mapped @${name} to ${platformContact.principal} using platform data`);
                    return [{
                        value: platformContact.principal,
                        displayName: platformContact.display
                    }];
                }
            }
        }

        const contactApi = this._platform.getCapability('contacts');
        if (contactApi === null)
            return [];

        let what : 'phone_number' | 'email_address' | 'contact';
        if (category === ValueCategory.PhoneNumber)
            what = 'phone_number';
        else if (category === ValueCategory.EmailAddress)
            what = 'email_address';
        else
            what = 'contact';
        return contactApi.lookup(what, name);
    }

    async askMissingContact(category : ValueCategory, name : string) : Promise<Ast.EntityValue> {
        await this._dlg.replyInterp(this._("No contact matches “${name}”."), { name });

        // straight up ask for the target category
        // this ensures we show a contact picker, which is better than
        // repeatedly asking the user
        const value = await this._dlg.ask(category === ValueCategory.Contact ? ValueCategory.PhoneNumber : category,
            this._("Who do you want to contact?"));
        assert(value instanceof Ast.EntityValue);
        return value;
    }

    protected async addDisplayToContact(contact : Ast.EntityValue) : Promise<void> {
        const principal = contact.value;
        if (!principal)
            return;

        if (this._dlg.platformData.contacts) {
            for (const platformContact of this._dlg.platformData.contacts) {
                if (platformContact.principal === principal) {
                    contact.display = platformContact.display;
                    return;
                }
            }
        }

        const contactApi = this._platform.getCapability('contacts');
        if (contactApi === null)
            return;

        const addressBookContact = await contactApi.lookupPrincipal(principal);
        if (addressBookContact)
            contact.display = addressBookContact.displayName;
    }

    private async _constructEntityQuery(kind : string, query : string, entityDisplay : string) {
        const schema = await this._schemas.getSchemaAndNames(kind, 'query', query);
        const filter = new Ast.BooleanExpression.Atom(null, 'id', '=~', new Ast.Value.String(entityDisplay));
        const invocation = (new Ast.Invocation(null, new Ast.DeviceSelector(null, kind, null, null), query, [], schema));
        const invocationTable = new Ast.InvocationExpression(null, invocation, schema);
        const filteredTable = new Ast.FilterExpression(null, invocationTable, filter, schema);
        return new Ast.ExpressionStatement(null, filteredTable);
    }

    protected async lookupEntityCandidates(entityType : string,
                                           entityDisplay : string,
                                           hints : DisambiguationHints) : Promise<EntityRecord[]> {
        // HACK this should be made generic with some new Genie annotation
        if (entityType === 'org.freedesktop:app_id') {
            const appLauncher = this._platform.getCapability('app-launcher');
            if (appLauncher)
                return appLauncher.listApps();
        }

        const { data: tpCandidates, meta } = await this._thingpedia.lookupEntity(entityType, entityDisplay);
        if (tpCandidates.length > 0)
            return tpCandidates;

        let stmt;
        try {
            const kind = entityType.split(":")[0];
            const query = entityType.split(":")[1];
            stmt = await this._constructEntityQuery(kind, query, entityDisplay);
        } catch(e) {
            // ignore an error here (it indicates the query is not an ID query)
        }

        let candidates = tpCandidates;
        if (stmt) {
            await this._prepareForExecution(stmt, hints);
            const [results,] = await this._executor.executeStatement(stmt);
            candidates = [];
            for (const item of results!.results) {
                const id = item.value.id;
                if (!id || !(id instanceof Ast.EntityValue))
                    continue;

                const entity = {
                    type: entityType,
                    value: id.value!,
                    canonical: id.display!.toLowerCase(),
                    name: id.display!
                };
                candidates.push(entity);
            }
        }

        if (candidates.length === 0) {
            await this._dlg.replyInterp(this._("Sorry, I cannot find any ${entity_type} matching “${name}”."), {
                entity_type: meta.name,
                name: entityDisplay
            });
            throw new CancellationError();
        }
        return candidates;
    }

    private async _tryGetCurrentLocation() : Promise<Ast.AbsoluteLocation|null> {
        const gps = this._platform.getCapability('gps');
        if (gps === null)
            return null;
        const location = await gps.getCurrentLocation();
        if (location === null) {
            this.debug('GPS location not available');
            return null;
        } else {
            return new Ast.Location.Absolute(location.latitude, location.longitude, location.display||null);
        }
    }

    protected async lookupLocation(searchKey : string, previousLocations : Ast.AbsoluteLocation[]) : Promise<Ast.LocationValue> {
        const currentLocation = await this._tryGetCurrentLocation();
        const lastLocation = previousLocations.length ? previousLocations[previousLocations.length - 1] : undefined;

        let around;
        if (lastLocation)
            around = { latitude: lastLocation.lat, longitude: lastLocation.lon };
        else if (currentLocation)
            around = { latitude: currentLocation.lat, longitude: currentLocation.lon };

        const candidates = await this._thingpedia.lookupLocation(searchKey, around);

        // ignore locations larger than a city
        const mapped = candidates.filter((c) => c.rank >= 16).map((c) => {
            return new Ast.Location.Absolute(c.latitude, c.longitude, c.display);
        });

        if (mapped.length === 0) {
            const question = this._dlg.interpolate(this._("Sorry, I cannot find any location matching “${location}”. What location are you looking for?"), {
                location: searchKey,
            });
            const answer = await this._dlg.ask(ValueCategory.Location, question);
            assert(answer instanceof Ast.LocationValue);
            if (answer.value instanceof Ast.UnresolvedLocation) {
                return this.lookupLocation(answer.value.name, previousLocations);
            } else if (answer.value instanceof Ast.RelativeLocation) {
                const resolved = await this.resolveUserContext('$context.location.' + answer.value.relativeTag);
                assert(resolved instanceof Ast.LocationValue);
                return resolved;
            } else {
                return answer;
            }
        }

        return new Ast.Value.Location(mapped[0]);
    }

    private _tryGetStoredVariable(type : Type, variable : string) : Ast.Value|null {
        const sharedPrefs = this._platform.getSharedPreferences();

        const value = sharedPrefs.get('context-' + variable);
        if (value === undefined)
            return null;
        return Ast.Value.fromJSON(type, value);
    }

    protected async resolveUserContext(variable : string) : Promise<Ast.Value> {
        let value : Ast.Value|null = null;
        switch (variable) {
            case '$context.location.current_location': {
                const location = await this._tryGetCurrentLocation();
                if (location)
                    value = new Ast.Value.Location(location);
                break;
            }
            case '$context.location.home':
            case '$context.location.work':
                value = this._tryGetStoredVariable(ThingTalk.Type.Location, variable);
                break;
            case '$context.time.morning':
            case '$context.time.evening':
                value = this._tryGetStoredVariable(ThingTalk.Type.Time, variable);
                break;
            default:
                throw new TypeError('Invalid variable ' + variable);
        }
        if (value !== null)
            return value;

        let saveToContext = false;
        let question, type;
        switch (variable) {
        case '$context.location.current_location':
            question = this._("Where are you now?");
            type = ValueCategory.Location;
            break;
        case '$context.location.home':
            question = this._("What is your home address?");
            type = ValueCategory.Location;
            saveToContext = true;
            break;
        case '$context.location.work':
            question = this._("What is your work address?");
            type = ValueCategory.Location;
            saveToContext = true;
            break;
        case '$context.time.morning':
            question = this._("What time does your morning begin?");
            type = ValueCategory.Time;
            saveToContext = true;
            break;
        case '$context.time.evening':
            question = this._("What time does your evening begin?");
            type = ValueCategory.Time;
            saveToContext = true;
            break;
        }

        let answer = await this._dlg.ask(type, question);
        if (type === ValueCategory.Location) {
            assert(answer instanceof Ast.LocationValue);

            if (answer.value instanceof Ast.RelativeLocation)
                answer = await this.resolveUserContext('$context.location.' + answer.value.relativeTag);
            else if (answer.value instanceof Ast.UnresolvedLocation)
                answer = await this.lookupLocation(answer.value.name, []);
        }

        if (saveToContext) {
            const sharedPrefs = this._platform.getSharedPreferences();
            sharedPrefs.set('context-' + variable, answer.toJS());
        }
        return answer;
    }

    protected getPreferredUnit(type : string) : string {
        // const locale = dlg.locale; // this is not useful
        const pref = this._platform.getSharedPreferences();
        let preferredUnit = pref.get('preferred-' + type) as string|undefined;
        // e.g. defaultTemperature will get from preferred-temperature
        if (preferredUnit === undefined) {
            switch (type) {
            case 'temperature':
                preferredUnit = this._getDefaultTemperatureUnit();
                break;
            default:
                throw new Error('Invalid default unit');
            }
        }
        return preferredUnit;
    }

    private _getDefaultTemperatureUnit() : string {
        // this method is quite hacky because it accounts for the fact that the locale
        // is always en-US, but we don't want

        let preferredUnit = 'C'; // Below code checks if we are in US
        if (this._platform.type !== 'cloud' && this._platform.type !== 'android') {
            const realLocale = process.env.LC_ALL || process.env.LC_MEASUREMENT || process.env.LANG || 'C';
            if (realLocale.indexOf('en_US') !== -1)
                preferredUnit = 'F';
        } else if (this._platform.type === 'cloud') {
            const realLocale = process.env.TZ || 'UTC';
            // timezones obtained from http://efele.net/maps/tz/us/
            const usTimeZones = [
                'America/New_York',
                'America/Chicago',
                'America/Denver',
                'America/Los_Angeles',
                'America/Adak',
                'America/Yakutat',
                'America/Juneau',
                'America/Sitka',
                'America/Metlakatla',
                'America/Anchrorage',
                'America/Nome',
                'America/Phoenix',
                'America/Honolulu',
                'America/Boise',
                'America/Indiana/Marengo',
                'America/Indiana/Vincennes',
                'America/Indiana/Tell_City',
                'America/Indiana/Petersburg',
                'America/Indiana/Knox',
                'America/Indiana/Winamac',
                'America/Indiana/Vevay',
                'America/Kentucky/Louisville',
                'America/Indiana/Indianapolis',
                'America/Kentucky/Monticello',
                'America/Menominee',
                'America/North_Dakota/Center',
                'America/North_Dakota/New_Salem',
                'America/North_Dakota/Beulah',
                'America/Boise',
                'America/Puerto_Rico',
                'America/St_Thomas',
                'America/Shiprock',
            ];
            if (usTimeZones.indexOf(realLocale) !== -1)
                preferredUnit = 'F';
        }
        return preferredUnit;
    }
}
