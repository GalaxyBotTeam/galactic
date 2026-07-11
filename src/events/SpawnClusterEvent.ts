import {z} from "zod";

export const SpawnClusterEventData = z.object({
    clusterID: z.number(),
    instanceID: z.number(),
    shardList: z.array(z.number()),
    token: z.string(),
    intents: z.array(z.string()),
    url: z.string().optional(),
    totalShards: z.number()
})

export const SpawnClusterEvent = z.object({
    type: z.literal('SPAWN_CLUSTER'),
    data: SpawnClusterEventData
})

export type SpawnClusterEvent = z.infer<typeof SpawnClusterEvent>
export type SpawnClusterEventData = z.infer<typeof SpawnClusterEventData>