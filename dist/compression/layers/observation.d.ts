/**
 * L6: Observation Compression (AGGRESSIVE)
 *
 * Inspired by claw-compactor's 97% compression on tool results.
 * Tool call results (especially large ones) are summarized to key info only.
 *
 * This is the biggest compression win - tool outputs can be 10KB+ but
 * only ~200 chars of actual useful information.
 */
import { NormalizedMessage } from "../types.js";
interface ObservationResult {
    messages: NormalizedMessage[];
    charsSaved: number;
    observationsCompressed: number;
}
/**
 * Compress tool results in messages.
 */
export declare function compressObservations(messages: NormalizedMessage[]): ObservationResult;
export {};
