import {z} from "zod";

export const KillClusterEvent = z.object({
    type: z.literal('KILL_CLUSTER'),
    data: z.object({
        clusterID: z.number(),
    })
})