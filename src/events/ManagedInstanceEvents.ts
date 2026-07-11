import {z} from "zod";
import {SpawnClusterEvent} from "./SpawnClusterEvent";
import {KillClusterEvent} from "./KillClusterEvent";

export const ManagedInstanceEvents = z.discriminatedUnion('type', [
    SpawnClusterEvent,
    KillClusterEvent,
])

export type ManagedInstanceAction = z.infer<typeof ManagedInstanceEvents>