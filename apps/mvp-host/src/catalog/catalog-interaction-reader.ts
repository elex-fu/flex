import { encodedBytes, InteractionGetRequestSchema, InteractionListRequestSchema, type Interaction } from "@flyx/mvp-protocol";
import type { SqliteStore } from "../storage/db.js";
import { validateInteractionSchema, INTERACTION_SCHEMA_VERSION } from "../storage/migrations/008-interactions.js";
import { InteractionStore } from "../interaction/interaction-store.js";
import { parseInteractionRpcPayload, type InteractionRpcPort } from "../interaction/host-interactions.js";
import { InteractionRpcError } from "../interaction/interaction-rpc.js";
import type { ViewInteractionReader, ViewInteractionPage } from "../timeline/host-views.js";
/** History directory only: no projection hook, runtime or response authority. */
export class CatalogInteractionReader implements InteractionRpcPort {
    private readonly interactions: InteractionStore;
    constructor(readonly store: SqliteStore, private readonly assertSession: (sessionId: string) => void) {
        validateInteractionSchema(store.db);
        this.interactions = new InteractionStore(store.db);
    }
    static isAvailable(store: SqliteStore): boolean {
        if (!store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(INTERACTION_SCHEMA_VERSION))
            return false;
        validateInteractionSchema(store.db);
        return true;
    }
    get(sessionId: string, interactionId: string): Interaction {
        this.assertSession(sessionId);
        const row = this.interactions.get(interactionId);
        if (!row || row.sessionId !== sessionId)
            throw new InteractionRpcError("INTERACTION_NOT_FOUND");
        return { ...this.interactions.public(row), responseAvailable: false };
    }
    readonly read: ViewInteractionReader = (sessionId, after) => this.list(sessionId, after);
    list(sessionId: string, after?: string): ViewInteractionPage {
        this.assertSession(sessionId);
        const rows = this.interactions.list(sessionId, { ...(after ? { afterInteractionId: after } : {}), limit: 51 });
        const interactions: Interaction[] = [];
        for (const row of rows) {
            const value = { ...this.interactions.public(row), responseAvailable: false };
            if (interactions.length >= 50 || encodedBytes({ interactions: [...interactions, value], hasMore: true }) > 48 * 1024)
                break;
            interactions.push(value);
        }
        const hasMore = interactions.length < rows.length;
        const last = interactions.at(-1);
        if (hasMore && !last)
            throw new InteractionRpcError("INTERACTION_DIRECTORY_INCOMPLETE");
        return { interactions, hasMore, ...(hasMore && last ? { nextAfterInteractionId: last.interactionId } : {}) };
    }
    rpc(method: Parameters<InteractionRpcPort["rpc"]>[0], payload: unknown): unknown {
        const input = parseInteractionRpcPayload(method, payload);
        if (method === "interaction.get") {
            const request = InteractionGetRequestSchema.parse(payload);
            return this.get(input.sessionId, request.interactionId);
        }
        if (method === "interaction.list") {
            const request = InteractionListRequestSchema.parse(payload);
            return this.list(input.sessionId, request.afterInteractionId);
        }
        throw new InteractionRpcError("INTERACTION_RUNTIME_UNAVAILABLE");
    }
}
