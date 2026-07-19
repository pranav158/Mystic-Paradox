
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

import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadGameData } from "../gameData/loader";



const PlayerHuntTable = loadGameData<any>("player_hunts_table.json");
const MatchmakerHuntTable = loadGameData<any>("matchmaker_hunts_table.json");

const ArenaEasyMatchmakerTable = loadGameData<any>("arena_easy_matchmaker_hunts.json");
const ArenaHardMatchmakerTable = loadGameData<any>("arena_hard_matchmaker_hunts.json");
const ArenaEliteMatchmakerTable = loadGameData<any>("arena_elite_matchmaker_hunts.json");
import { kill } from "node:process";
import { logger } from "../logger";

const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent";
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent";

export type Gameserver = {
    id: string,
    port: number,
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    processId: number,
    startTime: Date,
    
    
    state: "starting" | "ready" | "failed",
    launchId: string,
    readyTime?: Date
};

type ExpectedPlayer = {
    playerUid: string,
    playerHuntId: string
};

export let Gameservers: Gameserver[] = [];
let FreePorts: number[] = [];

let RamsgateServer : Gameserver;
let TrainingDojoServer : Gameserver;

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!;









































const STANDARD_GAMESERVER_ARGS = [
    "-EpicPortal",
    "-server",
    "-nullrhi",
    "-warp",
    "-RepDriverEnable",
    "-LogCmds=\"LogPhoenixCharacter VeryVerbose, LogOnline Verbose\""
];
const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);
const GAMESERVER_READY_TIMEOUT_MS = Number(process.env.GAMESERVER_READY_TIMEOUT_MS ?? "30000");





const TRIALS_ROTATION_ROW_COUNT = 181;
const DEFAULT_TRIALS_ROTATION_MINUTES = 7 * 24 * 60;

function ParseTrialsRotationMinutes(Value: string | undefined): number {
    const Parsed = Number(Value ?? DEFAULT_TRIALS_ROTATION_MINUTES);
    if(!Number.isSafeInteger(Parsed) || Parsed < 1 || Parsed > 525600){
        logger.warn(`[TrialsRotation] invalid TRIALS_ROTATION_MINUTES='${Value ?? ""}'; using ${DEFAULT_TRIALS_ROTATION_MINUTES}`);
        return DEFAULT_TRIALS_ROTATION_MINUTES;
    }
    return Parsed;
}

const TRIALS_ROTATION_MINUTES = ParseTrialsRotationMinutes(process.env.TRIALS_ROTATION_MINUTES);

function GetCurrentTrialsWeek(NowMs: number = Date.now()): string {
    const Bucket = Math.floor(NowMs / (TRIALS_ROTATION_MINUTES * 60_000));
    return String((Bucket % TRIALS_ROTATION_ROW_COUNT) + 1).padStart(3, "0");
}








const MAX_CONCURRENT_HUNT_SERVERS = Number(process.env.MAX_CONCURRENT_HUNT_SERVERS ?? "3");








const ENABLE_PUBLIC_HUNT_REUSE = (process.env.ENABLE_PUBLIC_HUNT_REUSE ?? "0") === "1";
const PUBLIC_HUNT_MAX_PLAYERS = Number(process.env.PUBLIC_HUNT_MAX_PLAYERS ?? "4");



export class NoHuntCapacityError extends Error {
    constructor(current: number, cap: number) {
        super(`Hunt server capacity reached (${current}/${cap})`);
        this.name = "NoHuntCapacityError";
    }
}

export class GameserverStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GameserverStartupError";
    }
}

function CountHuntServers(): number {
    return Gameservers.filter((Server) => !Server.isRamsgate && !Server.isTrainingDojo).length;
}



const GAMESERVER_LOG_DIR = path.resolve(
    process.env.GAMESERVER_LOG_DIR ?? path.join(process.cwd(), "../../debug/gameservers")
);
fs.mkdirSync(GAMESERVER_LOG_DIR, { recursive: true });

function TransformExpectedPlayerArgs(ExpectedPlayers: ExpectedPlayer[]){
    let ToReturn = "";

    for(const Player of ExpectedPlayers){
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }

    if(ToReturn.length > 0){
        ToReturn = ToReturn.slice(0, -1); 
    }

    return ToReturn;
}

function WaitForServerReady(Child: ReturnType<typeof spawn>, LaunchId: string, Port: number, Label: string): Promise<void> {
    if (!Child.stdout) {
        return Promise.reject(new GameserverStartupError(`${Label} port ${Port} has no stdout pipe for readiness`));
    }

    
    return new Promise((resolve, reject) => {
        let settled = false;
        let Buffered = "";

        const OnData = (Chunk: Buffer | string) => {
            Buffered += Chunk.toString();

            let NewlineIndex: number;
            while ((NewlineIndex = Buffered.indexOf("\n")) !== -1) {
                const Line = Buffered.slice(0, NewlineIndex);
                Buffered = Buffered.slice(NewlineIndex + 1);
                HandleLine(Line);
            }

            
            if (Buffered.length > 65536) Buffered = Buffered.slice(-4096);
        };

        const Finish = (Error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(Timeout);
            
            
            Child.stdout?.off("data", OnData);
            Child.off("exit", OnExit);
            Child.off("error", OnError);
            Error ? reject(Error) : resolve();
        };
        const OnExit = (Code: number | null, Signal: NodeJS.Signals | null) => Finish(new GameserverStartupError(`${Label} port ${Port} exited before ready (code=${Code ?? "null"}, signal=${Signal ?? "null"})`));
        const OnError = (Error: Error) => Finish(new GameserverStartupError(`${Label} port ${Port} failed before ready: ${Error.message}`));
        const Timeout = globalThis.setTimeout(() => Finish(new GameserverStartupError(`${Label} port ${Port} did not report ready within ${GAMESERVER_READY_TIMEOUT_MS}ms`)), GAMESERVER_READY_TIMEOUT_MS);

        function HandleLine(Line: string){
            const Match = /^MYSTICPARADOX_GAMESERVER_READY launchId=([0-9a-f-]+) port=(\d+)$/.exec(Line.trim());
            if (!Match) return;
            if (Match[1] !== LaunchId || Number(Match[2]) !== Port) {
                logger.warn(`Ignoring mismatched gameserver readiness marker on port ${Port}: ${Line}`);
                return;
            }
            Finish();
        }

        Child.stdout!.on("data", OnData);
        Child.once("exit", OnExit);
        Child.once("error", OnError);
    });
}

export async function CleanupServer(ServerToShutdown: Gameserver){    Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);

    if(ServerToShutdown.isRamsgate){
        logger.warn("RAMSGATE HAS FALLEN! Restarting!");

        RamsgateServer = await StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);
    }
    else if(ServerToShutdown.isTrainingDojo){
        logger.warn("Training Dojo Crashed! Restarting!");

        TrainingDojoServer = await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
    }
    else{
        FreePorts.push(ServerToShutdown.port);
    }
}

let ServerLaunchQueue: Promise<void> = Promise.resolve();

async function StartServer(Map: string, Behemoth: string | undefined, MatchmakerHuntId: string | undefined, ExpectedPlayers: ExpectedPlayer[] | undefined, IsRamsgate: boolean, IsTrainingDojo: boolean){
    
    
    
    
    
    
    if(!IsRamsgate && !IsTrainingDojo){
        const LaunchProc = ServerLaunchQueue;
        ServerLaunchQueue = ServerLaunchQueue.catch(() => {}).then(async () => await setTimeout(SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000));
        await LaunchProc;
    }

    let Port;

    if(IsRamsgate){
        Port = RAMSGATE_PORT;
    }
    else if(IsTrainingDojo){
        Port = TRAINING_DOJO_PORT;
    }
    else{
        
        
        
        if(CountHuntServers() >= MAX_CONCURRENT_HUNT_SERVERS){
            throw new NoHuntCapacityError(CountHuntServers(), MAX_CONCURRENT_HUNT_SERVERS);
        }
        Port = FreePorts.pop();
    }

    const Id = crypto.randomUUID();

    if(Port == undefined){
        throw new Error("No free ports left!");
    }

    
    
    
    const Label = IsRamsgate
        ? "ramsgate"
        : IsTrainingDojo
            ? "training_dojo"
            : (Behemoth != undefined ? Behemoth.split("/").pop()!.split(".")[0] : "hunt");
    const LogPath = path.join(GAMESERVER_LOG_DIR, `port${Port}_${Label}.log`);
    const LogStream = fs.createWriteStream(LogPath, { flags: "a" });
    LogStream.write(
        `=== Gameserver launch ${new Date().toLocaleString()} (local time) ===\n` +
        `port=${Port} map=${Map} behemoth=${Behemoth ?? "NO_BEHEMOTH"} ` +
        `mmHunt=${MatchmakerHuntId ?? "NO_MM_HUNTID"} ` +
        `players=${ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS"}\n\n`
    );

    
    
    
    const ArenaWeekMatch = MatchmakerHuntId?.match(/^Arena_MatchmakerHunt_(?:Easy|Hard|Elite)_(\d{3})$/);
    const ChildEnvironment = {
        ...process.env,
        MYSTICPARADOX_GAMESERVER_LAUNCH_ID: Id,
        ...(ArenaWeekMatch ? { MYSTICPARADOX_TRIALS_WEEK: ArenaWeekMatch[1] } : {})
    };

    const Child = spawn(GAMESERVER_BINARY_PATH, [
        METAGAME_API_KEY,
        Port.toString(),
        Map,
        Behemoth != undefined ? Behemoth : "NO_BEHEMOTH",
        MatchmakerHuntId != undefined ? MatchmakerHuntId : "NO_MM_HUNTID",
        ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS",
        MY_IP + ":" + Port.toString(),
        ...STANDARD_GAMESERVER_ARGS
    ], {
        stdio: ["ignore", "pipe", "pipe"],
        
        env: ChildEnvironment
    });

    Child.stdout?.pipe(LogStream);
    Child.stderr?.pipe(LogStream);
    LogStream.write(`pid=${Child.pid ?? "unknown"}\n\n`);

    logger.info(`${Label} spawned on port ${Port} (pid=${Child.pid ?? "unknown"}) -> ${LogPath}`);

    Child.on("exit", (code, signal) => {
        const ExitMessage = `Gameserver process exited port=${Port} label=${Label} pid=${Child.pid} code=${code ?? "null"} signal=${signal ?? "null"}`;
        logger.warn(ExitMessage);
        LogStream.write(`\n=== ${ExitMessage} ===\n`);

        
        
        
        
        if(!IsRamsgate && !IsTrainingDojo){
            Gameservers = Gameservers.filter((Server) => Server.processId !== Child.pid);
            if(Port != undefined && !FreePorts.includes(Port)){
                FreePorts.push(Port);
            }
        }
    });

    Child.on("error", (err) => {
        const ErrorMessage = `Gameserver process error port=${Port} label=${Label} pid=${Child.pid}: ${err.message}`;
        logger.error(ErrorMessage);
        LogStream.write(`\n=== ${ErrorMessage} ===\n`);
    });

    Child.unref();

    const NewGameserver: Gameserver = {
        id: Id,
        port: Port,
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: MatchmakerHuntId,
        expectedPlayers: ExpectedPlayers,
        isRamsgate: IsRamsgate,
        isTrainingDojo: IsTrainingDojo,
        processId: Child.pid!,
        startTime: new Date(),
        state: "starting",
        launchId: Id
    };

    Gameservers.push(NewGameserver);

    try {
        await WaitForServerReady(Child, Id, Port, Label);
        NewGameserver.state = "ready";
        NewGameserver.readyTime = new Date();
        logger.info(`${Label} ready on ${MY_IP}:${Port} after ${NewGameserver.readyTime.getTime() - NewGameserver.startTime.getTime()}ms`);
    }
    catch (Err: any) {
        NewGameserver.state = "failed";
        Gameservers = Gameservers.filter((Server) => Server !== NewGameserver);
        if (!IsRamsgate && !IsTrainingDojo && !FreePorts.includes(Port)) FreePorts.push(Port);
        if (Child.exitCode == undefined) Child.kill();
        throw Err instanceof GameserverStartupError ? Err : new GameserverStartupError(`${Label} port ${Port} readiness failed: ${Err?.message ?? Err}`);
    }

    return NewGameserver;
}

export function GetRamsgateConnectionDetails(){
    if (!RamsgateServer || RamsgateServer.state !== "ready") throw new GameserverStartupError("Ramsgate is not ready");
    return {
        host: MY_IP,
        port: RamsgateServer.port
    };
}

export function GetTrainingDojoConnectionDetails(){
    if (!TrainingDojoServer || TrainingDojoServer.state !== "ready") throw new GameserverStartupError("Training Dojo is not ready");
    return {
        host: MY_IP,
        port: TrainingDojoServer.port
    };
}









export function TryReuseSharedHuntServer(PlayerHuntId: string, JoinerUids: string[] | undefined): { host: string; port: number } | undefined {
    if(!ENABLE_PUBLIC_HUNT_REUSE) return undefined;
    if(PlayerHuntId == undefined || PlayerHuntId.trim().length === 0) return undefined;

    const Candidate = Gameservers.find((Server) =>
        Server.state === "ready"
        && !Server.isRamsgate
        && !Server.isTrainingDojo
        && Server.expectedPlayers != undefined
        && Server.expectedPlayers.length > 0
        && Server.expectedPlayers[0].playerHuntId === PlayerHuntId
        && Server.expectedPlayers.length < PUBLIC_HUNT_MAX_PLAYERS
    );

    if(Candidate == undefined) return undefined;

    if(JoinerUids != undefined){
        for(const Uid of JoinerUids){
            if(!Candidate.expectedPlayers!.some((Player) => Player.playerUid === Uid)){
                Candidate.expectedPlayers!.push({ playerUid: Uid, playerHuntId: PlayerHuntId });
            }
        }
    }

    logger.info(`[PublicHuntReuse] joining existing server port=${Candidate.port} pid=${Candidate.processId} huntId=${PlayerHuntId} roster=${Candidate.expectedPlayers!.length}/${PUBLIC_HUNT_MAX_PLAYERS}`);

    return {
        host: MY_IP,
        port: Candidate.port
    };
}

function GetArgValue(GameArgs: string, Key: string){
    const Query = GameArgs.split("?").slice(1);

    for(const Arg of Query){
        const [ArgKey, ...ValueParts] = Arg.split("=");

        if(ArgKey === Key){
            return ValueParts.join("=");
        }
    }

    return undefined;
}

function GetExpectedPlayers(PlayerIds: string[] | undefined, PlayerHuntId: string | undefined){
    if(PlayerIds == undefined || PlayerIds.length === 0 || PlayerHuntId == undefined || PlayerHuntId.trim().length === 0){
        return undefined;
    }

    return PlayerIds.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: PlayerHuntId
        };
    });
}

export async function StartupGameserverWithArgs(GameArgs: string, HuntId: string | undefined, ExpectedPlayers: string[] | undefined){
    const Map = GameArgs.split("?")[0];
    const Behemoth = GetArgValue(GameArgs, "MonsterClass");
    const MatchmakerHuntIdFromArgs = GetArgValue(GameArgs, "HuntID");
    const MatchmakerHuntId = MatchmakerHuntIdFromArgs != undefined && MatchmakerHuntIdFromArgs.trim().length > 0
        ? MatchmakerHuntIdFromArgs
        : (HuntId != undefined && HuntId.trim().length > 0 ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : undefined);

    const GameServerToReturn = await StartServer(Map, Behemoth, MatchmakerHuntId, GetExpectedPlayers(ExpectedPlayers, HuntId), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    };
}


type MatchmakerTableSource = { name: string; rows: Record<string, any> };

const MatchmakerTableSources: MatchmakerTableSource[] = [
    { name: "matchmaker_hunts_table",       rows: MatchmakerHuntTable[0].Rows as any },
    { name: "arena_easy_matchmaker_hunts",  rows: (ArenaEasyMatchmakerTable as any)[0].Rows },
    { name: "arena_hard_matchmaker_hunts",  rows: (ArenaHardMatchmakerTable as any)[0].Rows },
    { name: "arena_elite_matchmaker_hunts", rows: (ArenaEliteMatchmakerTable as any)[0].Rows }
];


function FindMatchmakerRow(MatchmakerHuntId: string): any | undefined {
    for(const Source of MatchmakerTableSources){
        const Row = Source.rows[MatchmakerHuntId];
        if(Row != undefined) return Row;
    }
    return undefined;
}

function GetMatchmakerTableByName(TableName: string): MatchmakerTableSource | undefined {
    return MatchmakerTableSources.find((Source) => Source.name === TableName);
}


function TagMatches(RowTag: string, QueryTag: string): boolean {
    return RowTag === QueryTag || RowTag.startsWith(`${QueryTag}.`);
}

function EvaluateTagQuery(Query: any, RowTags: string[]): boolean {
    const Stream: number[] = Query?.QueryTokenStream ?? Query?.queryTokenStream ?? [];
    const RawDictionary: any[] = Query?.TagDictionary ?? Query?.tagDictionary ?? [];

    
    const Dictionary = RawDictionary.map((Entry) =>
        typeof Entry === "string" ? Entry : Entry?.TagName ?? "");

    if(!Array.isArray(Stream) || Stream.length < 3) return false;

    let Index = 0;
    const Next = () => Stream[Index++];

    Next();                                  
    const HasRootExpression = Next();
    if(!HasRootExpression) return false;

    let Overflowed = false;

    function EvalExpr(): boolean {
        if(Index >= Stream.length){ Overflowed = true; return false; }

        const ExprType = Next();

        
        if(ExprType >= 1 && ExprType <= 3){
            const NumTags = Next();
            const Tags: string[] = [];
            for(let i = 0; i < NumTags; i++){
                const TagIndex = Next();
                const Tag = Dictionary[TagIndex];
                if(typeof Tag === "string" && Tag.length > 0) Tags.push(Tag);
            }
            const AnyMatched = Tags.some((QueryTag) => RowTags.some((RowTag) => TagMatches(RowTag, QueryTag)));
            const AllMatched = Tags.every((QueryTag) => RowTags.some((RowTag) => TagMatches(RowTag, QueryTag)));

            if(ExprType === 1) return AnyMatched;   
            if(ExprType === 2) return AllMatched;   
            return !AnyMatched;                     
        }

        
        if(ExprType >= 4 && ExprType <= 6){
            const NumExprs = Next();
            const Results: boolean[] = [];
            for(let i = 0; i < NumExprs; i++) Results.push(EvalExpr());

            if(ExprType === 4) return Results.some(Boolean);    
            if(ExprType === 5) return Results.every(Boolean);   
            return !Results.some(Boolean);                      
        }

        
        Overflowed = true;
        return false;
    }

    const Result = EvalExpr();
    return Overflowed ? false : Result;
}


function ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId: string, Row: any): string[] {
    const Lists = Row?.MatchmakerHuntsByTag;
    if(!Array.isArray(Lists) || Lists.length === 0) return [];

    const Resolved: string[] = [];

    for(const List of Lists){
        
        const ObjectName: string = List?.MatchmakerTable?.ObjectName ?? List?.matchmakerTable ?? "";
        const TableName = ObjectName.includes("'")
            ? ObjectName.split("'")[1]
            : ObjectName;

        const Source = GetMatchmakerTableByName(TableName);
        if(Source == undefined){
            logger.warn(`[HuntTagRouting] ${PlayerHuntId} references matchmaker table '${TableName}' which is not registered — add its vendored JSON to MatchmakerTableSources`);
            continue;
        }

        const Queries = List?.HuntTags ?? List?.queries ?? [];
        if(!Array.isArray(Queries) || Queries.length === 0) continue;

        for(const [RowName, MatchmakerRow] of Object.entries(Source.rows)){
            const RowTags: string[] = (MatchmakerRow as any)?.HuntTags ?? [];
            if(!Array.isArray(RowTags) || RowTags.length === 0) continue;

            
            if(Queries.every((Query: any) => EvaluateTagQuery(Query, RowTags))) Resolved.push(RowName);
        }
    }

    return Resolved;
}


type MissingHuntRequest = { count: number; firstSeen: Date; lastSeen: Date };
const MissingHuntRequests = new Map<string, MissingHuntRequest>();

function RecordMissingHuntRequest(PlayerHuntId: string){
    const Now = new Date();
    const Existing = MissingHuntRequests.get(PlayerHuntId);

    if(Existing == undefined){
        MissingHuntRequests.set(PlayerHuntId, { count: 1, firstSeen: Now, lastSeen: Now });
        
        logger.error(`[HuntTableGap] Client requested HuntId '${PlayerHuntId}' which is absent from player_hunts_table. This hunt CANNOT start. The vendored tables predate this content — re-export with CatalogExporter EXPORT_HUNTS=1 and import the new rows.`);
        return;
    }

    Existing.count++;
    Existing.lastSeen = Now;
}

export function GetMissingHuntRequests(){
    return [...MissingHuntRequests.entries()]
        .map(([HuntId, Info]) => ({ huntId: HuntId, ...Info }))
        .sort((A, B) => B.count - A.count);
}


export function LogMissingHuntRequests(){
    if(MissingHuntRequests.size === 0) return;

    const Summary = GetMissingHuntRequests()
        .map((Entry) => `${Entry.huntId} x${Entry.count}`)
        .join(", ");

    logger.warn(`[HuntTableGap] ${MissingHuntRequests.size} hunt id(s) requested but missing from player_hunts_table: ${Summary}`);
}

function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId: string): string{
    const Row = (PlayerHuntTable[0].Rows as any)[PlayerHuntId];

    
    
    if(Row == undefined){
        RecordMissingHuntRequest(PlayerHuntId);
        throw new Error(`player_hunts_table has no usable row for HuntId '${PlayerHuntId}' (missing row or empty MatchmakerHuntIDs)`);
    }

    const DirectMatchmakerHuntIds: string[] = Array.isArray(Row.MatchmakerHuntIDs)
        ? Row.MatchmakerHuntIDs
            .map((Entry: any) => Entry?.RowName)
            .filter((RowName: unknown): RowName is string =>
                typeof RowName === "string" && RowName.length > 0 && FindMatchmakerRow(RowName) != undefined)
        : [];

    
    let UsableMatchmakerHuntIds = DirectMatchmakerHuntIds;

    let TagRouted = false;
    if(UsableMatchmakerHuntIds.length === 0){
        UsableMatchmakerHuntIds = ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row);

        if(UsableMatchmakerHuntIds.length > 0){
            TagRouted = true;
            logger.info(`[HuntTagRouting] ${PlayerHuntId} resolved to ${UsableMatchmakerHuntIds.length} matchmaker row(s) via tag query`);
        }
    }

    if (UsableMatchmakerHuntIds.length === 0) {
        throw new Error(`player_hunts_table row '${PlayerHuntId}' has no resolvable 1.12 MatchmakerHuntIDs`);
    }

    
    
    
    if (TagRouted) {
        const ArenaCandidates = UsableMatchmakerHuntIds.filter((Id) =>
            /^Arena_MatchmakerHunt_(?:Easy|Hard|Elite)_\d{3}$/.test(Id)
        );
        if(ArenaCandidates.length > 0){
            const Week = GetCurrentTrialsWeek();
            const Pinned = ArenaCandidates.filter((Id) => Id.endsWith(`_${Week}`));
            if (Pinned.length > 0) {
                const Chosen = Pinned[crypto.randomInt(0, Pinned.length)];
                logger.info(`[TrialsRotation] interval=${TRIALS_ROTATION_MINUTES}m featured=_${Week} -> ${Chosen}`);
                return Chosen;
            }
            logger.warn(`[TrialsRotation] no arena row matched featured week _${Week}; falling back to a numbered arena candidate`);
            const Chosen = ArenaCandidates[crypto.randomInt(0, ArenaCandidates.length)];
            return Chosen;
        }
    }

    return UsableMatchmakerHuntIds[crypto.randomInt(0, UsableMatchmakerHuntIds.length)];
}

function GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId: string): string | undefined{
    const MatchmakerHuntObject = FindMatchmakerRow(MatchmakerHuntId);

    if(MatchmakerHuntObject == undefined){
        throw new Error(`matchmaker_hunts_table has no row for MatchmakerHuntId '${MatchmakerHuntId}'`);
    }

    const AssetPathName = MatchmakerHuntObject?.SpecificBehemoth?.BehemothAsset?.AssetPathName;

    
    
    if(AssetPathName == undefined || AssetPathName === "None" || String(AssetPathName).trim().length === 0){
        return undefined;
    }

    return AssetPathName;
}

function GetMapPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = FindMatchmakerRow(MatchmakerHuntId);

    if(MatchmakerHuntObject == undefined || !Array.isArray(MatchmakerHuntObject.MapList) || MatchmakerHuntObject.MapList.length === 0){
        throw new Error(`matchmaker_hunts_table row '${MatchmakerHuntId}' has no MapList`);
    }

    const UsableMaps = MatchmakerHuntObject.MapList
        .map((Entry: any) => Entry?.MapAssetName)
        .filter((MapAssetName: unknown): MapAssetName is string => typeof MapAssetName === "string" && MapAssetName.startsWith("/Game/") && MapAssetName.includes("."));
    if (UsableMaps.length === 0) {
        throw new Error(`matchmaker_hunts_table row '${MatchmakerHuntId}' has no valid /Game/ map asset path`);
    }
    const MapAssetName = UsableMaps[crypto.randomInt(0, UsableMaps.length)];
    return MapAssetName.slice(0, MapAssetName.lastIndexOf("."));
}

export async function StartupGameserverWithHuntIdAndPlayers(HuntId: string, ExpectedPlayers: string[]){
    const MatchmakerHuntId = GetMatchmakerHuntIdFromPlayerHuntId(HuntId);
    const BehemothPath = GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId);
    const MapPath = GetMapPathFromMatchmakerHuntId(MatchmakerHuntId);

    const GameServerToReturn = await StartServer(MapPath, BehemothPath, MatchmakerHuntId, ExpectedPlayers.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: HuntId
        };
    }), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    }
}


function LogHuntFamilyCoverage(PlayerHuntIds: string[]){
    const Families = new Map<string, string[]>();

    for(const HuntId of PlayerHuntIds){
        const Match = /^(.*?)([A-Z])$/.exec(HuntId);
        if(Match == undefined) continue;

        const [, Prefix, Suffix] = Match;
        const Existing = Families.get(Prefix);
        if(Existing == undefined) Families.set(Prefix, [Suffix]);
        else Existing.push(Suffix);
    }

    for(const [Prefix, Suffixes] of [...Families.entries()].sort()){
        
        if(Suffixes.length < 3) continue;

        const Sorted = [...Suffixes].sort();
        const First = Sorted[0];
        const Last = Sorted[Sorted.length - 1];
        const Expected = Last.charCodeAt(0) - First.charCodeAt(0) + 1;
        const Gap = Expected > Sorted.length ? " (NON-CONTIGUOUS)" : "";

        logger.info(`[HuntTableCoverage] ${Prefix}: ${First}-${Last} (${Sorted.length})${Gap}`);
    }
}


export function ValidateHuntTableData() {
    const PlayerRows = (PlayerHuntTable[0].Rows as Record<string, any>);
    const MatchmakerRows = (MatchmakerHuntTable[0].Rows as Record<string, any>);
    const Problems: string[] = [];
    let DirectPlayerRows = 0;
    let TagRoutedReferences = 0;
    let TagRoutedPlayerRows = 0;

    const HasValidMapPath = (MatchmakerRow: any) =>
        Array.isArray(MatchmakerRow?.MapList) && MatchmakerRow.MapList.some((Map: any) =>
            typeof Map?.MapAssetName === "string" && Map.MapAssetName.startsWith("/Game/") && Map.MapAssetName.includes("."));

    for (const [PlayerHuntId, Row] of Object.entries(PlayerRows)) {
        const HasDirect = Array.isArray(Row?.MatchmakerHuntIDs) && Row.MatchmakerHuntIDs.length > 0;

        if (!HasDirect) {
            
            
            
            const Resolved = ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row);
            if (Resolved.length === 0) continue;

            TagRoutedPlayerRows++;
            const Unusable = Resolved.filter((RowName) => !HasValidMapPath(FindMatchmakerRow(RowName)));
            if (Unusable.length > 0) {
                Problems.push(`${PlayerHuntId} -> ${Unusable.length}/${Resolved.length} tag-routed rows have no valid map`);
            }
            continue;
        }

        DirectPlayerRows++;
        for (const Entry of Row.MatchmakerHuntIDs) {
            const MatchmakerHuntId = Entry?.RowName;
            
            if (MatchmakerHuntId === "None") { TagRoutedReferences++; continue; }
            
            const MatchmakerRow = typeof MatchmakerHuntId === "string" ? FindMatchmakerRow(MatchmakerHuntId) : undefined;
            if (!MatchmakerRow) { Problems.push(`${PlayerHuntId} -> missing MatchmakerHunt '${String(MatchmakerHuntId)}'`); continue; }
            if (!HasValidMapPath(MatchmakerRow)) Problems.push(`${PlayerHuntId} -> ${MatchmakerHuntId} has no valid map`);
        }
    }
    const Summary = { playerRows: Object.keys(PlayerRows).length, directPlayerRows: DirectPlayerRows, tagRoutedReferences: TagRoutedReferences, matchmakerRows: Object.keys(MatchmakerRows).length, problems: Problems };
    logger.info(`[HuntTableAudit] playerRows=${Summary.playerRows} directRows=${Summary.directPlayerRows} tagRoutedRows=${TagRoutedPlayerRows} tagRoutedRefs=${Summary.tagRoutedReferences} matchmakerRows=${Summary.matchmakerRows} (+${MatchmakerTableSources.length - 1} aux tables) problems=${Problems.length}`);
    LogHuntFamilyCoverage(Object.keys(PlayerRows));
    for (const Problem of Problems.slice(0, 20)) logger.warn(`[HuntTableAudit] ${Problem}`);
    if (Problems.length > 20) logger.warn(`[HuntTableAudit] ${Problems.length - 20} additional problems omitted`);
    return Summary;
}

export async function Startup(){
    ValidateHuntTableData();
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        FreePorts.push(i);
    }

    
    
    
    
    
    const Failures: string[] = [];
    try {
        RamsgateServer = await StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);
    } catch (Error) {
        Failures.push(`ramsgate: ${String(Error)}`);
    }

    try {
        TrainingDojoServer = await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
    } catch (Error) {
        Failures.push(`training_dojo: ${String(Error)}`);
    }

    if (Failures.length > 0) throw new GameserverStartupError(`Persistent hub startup failed (${Failures.join("; ")})`);
}
