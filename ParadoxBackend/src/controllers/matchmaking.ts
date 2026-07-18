/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import crypto from "node:crypto";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";

type MatchmakingQueueData = {
    Players: string[],
    LastPlayerAddedTime: Date,
    Resolved: boolean
};

type MatchmakingResult = {
    Ready: boolean,
    HuntId: string,
    CandidateId: string,
    GameSessionId: string,
    Host: string,
    Port: number,
    
    
    ReadyAt: number
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); 
let MatchmakingResultMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); 
let PartyInstanceMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); 
let PartyInstanceCreatedAtMap: Map<string, number> = new Map<string, number>(); 









const HubGameSessionIds: Map<string, string> = new Map<string, string>();

function GetHubGameSessionId(Host: string, Port: number): string {
    const Key = `${Host}:${Port}`;
    let Id = HubGameSessionIds.get(Key);
    if (Id == undefined) {
        Id = crypto.randomUUID();
        HubGameSessionIds.set(Key, Id);
    }
    return Id;
}





const PARTY_INSTANCE_REUSE_MS = 120000;



function ReadDelayMs(Name: string, Fallback: number): number {
    const Value = Number(process.env[Name]);
    return Number.isFinite(Value) && Value > 0 ? Math.floor(Value) : Fallback;
}

const HUNT_GO_NOW_MIN_DELAY_MS = ReadDelayMs("HUNT_GO_NOW_MIN_DELAY_MS", 10000);
const HUNT_GO_NOW_MAX_DELAY_MS = ReadDelayMs("HUNT_GO_NOW_MAX_DELAY_MS", 20000);








const HUB_GO_NOW_MIN_DELAY_MS = ReadDelayMs("HUB_GO_NOW_MIN_DELAY_MS", 0);
const HUB_GO_NOW_MAX_DELAY_MS = ReadDelayMs("HUB_GO_NOW_MAX_DELAY_MS", 1000);





const GO_NOW_LOAD_PADDING_PER_JOINER_MS = ReadDelayMs("GO_NOW_LOAD_PADDING_PER_JOINER_MS", 1000);
const GO_NOW_LOAD_PADDING_MAX_MS = ReadDelayMs("GO_NOW_LOAD_PADDING_MAX_MS", 20000);





function CountInFlightReleases(): number {
    const Now = Date.now();
    let Count = 0;
    for (const Result of MatchmakingResultMap.values()) {
        if (Result.ReadyAt > Now) Count++;
    }
    return Count;
}






function CreateGoNowReleaseAt(IsHub: boolean): number {
    const LoadPadding = Math.min(CountInFlightReleases() * GO_NOW_LOAD_PADDING_PER_JOINER_MS, GO_NOW_LOAD_PADDING_MAX_MS);
    const BaseMin = IsHub ? HUB_GO_NOW_MIN_DELAY_MS : HUNT_GO_NOW_MIN_DELAY_MS;
    const BaseMax = IsHub ? HUB_GO_NOW_MAX_DELAY_MS : HUNT_GO_NOW_MAX_DELAY_MS;
    const Min = Math.min(BaseMin, BaseMax);
    const Max = Math.max(Min, BaseMax) + LoadPadding;
    return Date.now() + crypto.randomInt(Min, Max + 1);
}

function IsClientReady(Result: MatchmakingResult): boolean {
    return Result.Ready && (Result.ReadyAt === 0 || Date.now() >= Result.ReadyAt);
}

function ClientVisibleResult(Result: MatchmakingResult): MatchmakingResult {
    return { ...Result, Ready: IsClientReady(Result) };
}

export function GetCandidateStatusPeriodMillis(Result: MatchmakingResult): number {
    
    
    return Result.ReadyAt > Date.now() ? 1000 : 10000;
}

function GetFallbackHuntId(GameMode: string, GameArgs: string, HuntId: string | undefined){
    if(HuntId != undefined && HuntId.trim().length > 0){
        return HuntId;
    }

    if(GameMode === "CITY"){
        return "ShatteredIsles_ReturnToRamsgate";
    }

    if(GameArgs != undefined && GameArgs.includes("/Game/Maps/islands/1705/dia_moss_triforce")){
        return "ShatteredIsles_IslandA";
    }

    return HuntId ?? "";
}

function HuntIdRequiresMatchmaking(HuntId: string){
    return HuntId.includes("CR19");
}




function IsHubDestination(GameMode: string, HuntId: string | undefined){
    if(GameMode === "CITY"){
        return true;
    }
    if(HuntId == undefined){
        return false;
    }
    return HuntId.includes("ReturnToRamsgate") || HuntId.includes("TrainingDojo");
}

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined){
    logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;

    const MatchmakingResult = await fetch(URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            GameMode: GameMode,
            GameArgs: GameArgs,
            HuntId: HuntId,
            ExpectedPlayers: ExpectedPlayers!
        })
    });

    if(MatchmakingResult.status === 200){
        const MatchmakingData = await MatchmakingResult.json();

        logger.info(`DeployServer returned gameserver ${MatchmakingData.host}:${MatchmakingData.port}`);

        return {
            succeeded: true,
            readyNow: true,
            host: MatchmakingData.host,
            port: MatchmakingData.port
        }
    }
    else{
        logger.error(`DeployServer returned status ${MatchmakingResult.status}`);

        return {
            succeeded: false,
            readyNow: false,
            host: "",
            port: 0
        };
    }
}

async function PopQueue(HuntId: string){
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);

    if(MatchmakingQueue!.Resolved){
        return;
    }

    MatchmakingQueue!.Resolved = true;
    
    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue!.Players);
    const ReleaseAt = CreateGoNowReleaseAt(false);
    logger.info(`Hunt '${HuntId}' is online; synchronized Go Now release in ${ReleaseAt - Date.now()}ms for ${MatchmakingQueue!.Players.length} queued player(s)`);

    for(const Player of MatchmakingQueue!.Players){
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);

        if(PlayerMatchmakingResultToUpdate != undefined){
            PlayerMatchmakingResultToUpdate.Host = GameOnDeployServer.host;
            PlayerMatchmakingResultToUpdate.Port = GameOnDeployServer.port;
            PlayerMatchmakingResultToUpdate.Ready = true;
            PlayerMatchmakingResultToUpdate.ReadyAt = ReleaseAt;
        }
    }

    MatchmakingQueueMap.delete(HuntId);
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined){
        return undefined;
    }

    if(!PlayerMatchmakingResult.Ready){
        const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);

        if((new Date()).getTime() - MatchmakingQueue!.LastPlayerAddedTime.getTime() > 20000){ // existing 20s queue behavior
            await PopQueue(PlayerMatchmakingResult.HuntId);
        }
    }

    return ClientVisibleResult(MatchmakingResultMap.get(PlayerId)!);
}




async function QueuePlayer(HuntId: string, PlayerId: string){
    if(MatchmakingQueueMap.get(HuntId) != undefined && !MatchmakingQueueMap.get(HuntId)?.Resolved){
        const CurrentMMEntry = MatchmakingQueueMap.get(HuntId);

        CurrentMMEntry!.Players.push(PlayerId);
        CurrentMMEntry!.LastPlayerAddedTime = new Date();

        if(CurrentMMEntry!.Players.length >= 4){
            await PopQueue(HuntId);
        }
    }
    else if(MatchmakingQueueMap.get(HuntId) != undefined){
        return false;
    }
    else{
        MatchmakingQueueMap.set(HuntId, {
            Players: [PlayerId],
            LastPlayerAddedTime: new Date(),
            Resolved: false
        });
    }

    const CandidateId = crypto.randomUUID();
    MatchmakingResultMap.set(PlayerId, {
        Ready: false,
        CandidateId,
        GameSessionId: CandidateId,
        HuntId: HuntId,
        Host: "",
        Port: 0,
        ReadyAt: 0
    });

    return true;
}




async function HandlePartyMatchmaking(HuntId: string, PlayerId: string, PartyId: string, PartyMembers: string[]){
    const Existing = PartyInstanceMap.get(PartyId);
    const ExistingCreatedAt = PartyInstanceCreatedAtMap.get(PartyId) ?? 0;

    
    
    
    
    
    if(Existing != undefined && Existing.HuntId === HuntId && (Date.now() - ExistingCreatedAt) < PARTY_INSTANCE_REUSE_MS){
        
        
        MatchmakingResultMap.set(PlayerId, { ...Existing, CandidateId: crypto.randomUUID() });
        return true;
    }

    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, PartyMembers);

    if(!GameOnDeployServer.succeeded){
        return false;
    }

    const CandidateId = crypto.randomUUID();
    const SharedResult: MatchmakingResult = {
        Ready: true,
        CandidateId,
        GameSessionId: CandidateId,
        HuntId: HuntId,
        Host: GameOnDeployServer.host,
        Port: GameOnDeployServer.port,
        ReadyAt: CreateGoNowReleaseAt(false)
    };

    logger.info(`Party ${PartyId} hunt '${HuntId}' is online; synchronized Go Now release in ${SharedResult.ReadyAt - Date.now()}ms for ${PartyMembers.length} member(s)`);
    PartyInstanceMap.set(PartyId, SharedResult);
    PartyInstanceCreatedAtMap.set(PartyId, Date.now());

    for(const Member of PartyMembers){
        MatchmakingResultMap.set(Member, { ...SharedResult, CandidateId: crypto.randomUUID() });
    }

    return true;
}


export function GetPartyInstance(PartyId: string): MatchmakingResult | undefined {
    const Result = PartyInstanceMap.get(PartyId);
    return Result ? ClientVisibleResult(Result) : undefined;
}

export function GetPlayerCandidate(PlayerId: string): MatchmakingResult | undefined {
    const Result = MatchmakingResultMap.get(PlayerId);
    return Result ? ClientVisibleResult(Result) : undefined;
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string, PartyId?: string, PartyMembers?: string[]){
    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return false;
    }
    else if(MATCHMAKING_MODE === "DEPLOYSERVER"){
        const EffectiveHuntId = GetFallbackHuntId(GameMode, GameArgs, HuntId);

        
        
        
        
        
        
        
        
        if(!IsHubDestination(GameMode, EffectiveHuntId) && EffectiveHuntId.trim().length > 0
           && PartyId != undefined && PartyMembers != undefined && PartyMembers.length > 1){
            return await HandlePartyMatchmaking(EffectiveHuntId, PlayerId, PartyId, PartyMembers);
        }

        if(EffectiveHuntId == undefined || EffectiveHuntId.trim().length == 0 || !HuntIdRequiresMatchmaking(EffectiveHuntId)){
            
            
            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, EffectiveHuntId, PartyMembers ?? [PlayerId]);

            if(!GameOnDeployServer.succeeded){
                return false;
            }

            const IsHub = IsHubDestination(GameMode, EffectiveHuntId);
            const CandidateId = crypto.randomUUID();
            const SharedResult: MatchmakingResult = {
                Ready: true,
                CandidateId,
                GameSessionId: IsHub
                    ? GetHubGameSessionId(GameOnDeployServer.host, GameOnDeployServer.port)
                    : CandidateId,
                HuntId: EffectiveHuntId,
                Host: GameOnDeployServer.host,
                Port: GameOnDeployServer.port,
                
                
                
                
                ReadyAt: CreateGoNowReleaseAt(IsHub)
            };

            logger.info(`${IsHub ? "Hub" : "Hunt"} '${EffectiveHuntId}' is online; synchronized Go Now release in ${SharedResult.ReadyAt - Date.now()}ms candidateId=${SharedResult.CandidateId} gameSessionId=${SharedResult.GameSessionId}`);

            
            
            
            
            
            
            
            if(PartyId != undefined && PartyMembers != undefined && PartyMembers.length > 1){
                PartyInstanceMap.set(PartyId, SharedResult);
                PartyInstanceCreatedAtMap.set(PartyId, Date.now());
                for(const Member of PartyMembers){
                    
                    
                    MatchmakingResultMap.set(Member, { ...SharedResult, CandidateId: crypto.randomUUID() });
                }
            }
            else{
                if(PartyId != undefined){
                    PartyInstanceMap.delete(PartyId);
                    PartyInstanceCreatedAtMap.delete(PartyId);
                }
                MatchmakingResultMap.set(PlayerId, { ...SharedResult });
            }

            return true;
        }
        else if(PartyId != undefined && PartyMembers != undefined && PartyMembers.length > 1){
            
            return await HandlePartyMatchmaking(EffectiveHuntId, PlayerId, PartyId, PartyMembers);
        }
        else{
            return await QueuePlayer(EffectiveHuntId, PlayerId);
        }
    }
    else{
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return false;
    }
}
