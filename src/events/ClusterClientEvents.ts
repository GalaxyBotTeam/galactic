import {z} from "zod";
import {StopClusterSelfEvent} from "./StopClusterSelfEvent";

export const ClusterClientEvents = z.discriminatedUnion('type', [
    StopClusterSelfEvent
])

export type ClusterClientEvent = z.infer<typeof ClusterClientEvents>