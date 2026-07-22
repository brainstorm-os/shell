import {
	ENGINE_TRIGGER_KINDS,
	EntityEventVerb,
	RecurrenceKind,
	TriggerKind,
	type Weekday,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	BUILDER_TRIGGER_KINDS,
	SUGGESTED_TRIGGER_TYPES,
	TimePreset,
	builderTriggerFromDef,
	builderTriggerToDef,
	emptyBuilderTrigger,
	mintWebhookRouteId,
	mintWebhookSecret,
	triggerTypeSuggestions,
} from "./builder-trigger";

describe("builder trigger", () => {
	it("offers only the engine-wired trigger kinds", () => {
		expect(BUILDER_TRIGGER_KINDS).toBe(ENGINE_TRIGGER_KINDS);
	});

	it("defaults to a Manual trigger", () => {
		expect(emptyBuilderTrigger().kind).toBe(TriggerKind.Manual);
	});

	it("offers the Webhook kind (engine-wired in 11b.8)", () => {
		expect(BUILDER_TRIGGER_KINDS).toContain(TriggerKind.Webhook);
	});

	it("mints a route id + secret when a Webhook trigger is first saved", () => {
		const def = builderTriggerToDef({ ...emptyBuilderTrigger(), kind: TriggerKind.Webhook });
		expect(def.kind).toBe(TriggerKind.Webhook);
		expect(typeof def.config.routeId).toBe("string");
		expect(typeof def.config.secret).toBe("string");
		expect((def.config.secret as string).length).toBeGreaterThan(16);
	});

	it("preserves an existing route + secret on re-save (stable URL)", () => {
		const webhook = { routeId: "route-1", secret: "secret-1" };
		const def = builderTriggerToDef({ ...emptyBuilderTrigger(), kind: TriggerKind.Webhook, webhook });
		expect(def.config).toEqual(webhook);
	});

	it("round-trips a Webhook trigger through from/to def", () => {
		const webhook = { routeId: mintWebhookRouteId(), secret: mintWebhookSecret() };
		const def = builderTriggerToDef({ ...emptyBuilderTrigger(), kind: TriggerKind.Webhook, webhook });
		const recovered = builderTriggerFromDef(def);
		expect(recovered.kind).toBe(TriggerKind.Webhook);
		expect(recovered.webhook).toEqual(webhook);
	});

	it("mints url-safe tokens (no +/= chars)", () => {
		for (const token of [mintWebhookRouteId(), mintWebhookSecret()]) {
			expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it("offers the FileWatch kind (engine-wired in 11b.10)", () => {
		expect(BUILDER_TRIGGER_KINDS).toContain(TriggerKind.FileWatch);
	});

	it("round-trips a FileWatch trigger (watchId + displayName)", () => {
		const fileWatch = { watchId: "fw_abc", displayName: "report.csv" };
		const def = builderTriggerToDef({
			...emptyBuilderTrigger(),
			kind: TriggerKind.FileWatch,
			fileWatch,
		});
		expect(def.kind).toBe(TriggerKind.FileWatch);
		expect(def.config).toEqual(fileWatch);
		const recovered = builderTriggerFromDef(def);
		expect(recovered.kind).toBe(TriggerKind.FileWatch);
		expect(recovered.fileWatch).toEqual(fileWatch);
	});

	it("maps a Manual trigger to an empty-config def", () => {
		const def = builderTriggerToDef(emptyBuilderTrigger());
		expect(def.kind).toBe(TriggerKind.Manual);
		expect(def.config).toEqual({});
		expect(def.enabled).toBe(true);
	});

	it("maps a Startup trigger to an empty-config def (11b.10)", () => {
		const def = builderTriggerToDef({ ...emptyBuilderTrigger(), kind: TriggerKind.Startup });
		expect(def.kind).toBe(TriggerKind.Startup);
		expect(def.config).toEqual({});
		expect(def.enabled).toBe(true);
	});

	it("maps a daily Time preset to a Daily recurrence", () => {
		const def = builderTriggerToDef({ ...emptyBuilderTrigger(), kind: TriggerKind.Time });
		expect(def.kind).toBe(TriggerKind.Time);
		expect((def.config.recurrence as { kind: RecurrenceKind }).kind).toBe(RecurrenceKind.Daily);
	});

	it("maps a weekdays preset to a multi-day Weekly recurrence", () => {
		const def = builderTriggerToDef({
			...emptyBuilderTrigger(),
			kind: TriggerKind.Time,
			timePreset: TimePreset.Weekdays,
		});
		const rec = def.config.recurrence as { kind: RecurrenceKind; days?: Weekday[] };
		expect(rec.kind).toBe(RecurrenceKind.Weekly);
		expect(rec.days).toHaveLength(5);
	});

	it("maps an EntityEvent trigger to its type + verb config", () => {
		const def = builderTriggerToDef({
			...emptyBuilderTrigger(),
			kind: TriggerKind.EntityEvent,
			entityType: "  brainstorm/Bookmark/v1  ",
			verb: EntityEventVerb.Create,
		});
		expect(def.kind).toBe(TriggerKind.EntityEvent);
		expect(def.config).toEqual({
			entityType: "brainstorm/Bookmark/v1",
			verb: EntityEventVerb.Create,
		});
	});

	it("round-trips an EntityEvent def back into editable fields", () => {
		const def = builderTriggerToDef({
			...emptyBuilderTrigger(),
			kind: TriggerKind.EntityEvent,
			entityType: "brainstorm/Task/v1",
			verb: EntityEventVerb.Update,
		});
		const back = builderTriggerFromDef(def);
		expect(back.kind).toBe(TriggerKind.EntityEvent);
		expect(back.entityType).toBe("brainstorm/Task/v1");
		expect(back.verb).toBe(EntityEventVerb.Update);
	});

	it("recovers a weekly preset from a single-day recurrence", () => {
		const def = builderTriggerToDef({
			...emptyBuilderTrigger(),
			kind: TriggerKind.Time,
			timePreset: TimePreset.Weekly,
		});
		expect(builderTriggerFromDef(def).timePreset).toBe(TimePreset.Weekly);
	});

	it("recovers a monthly preset", () => {
		const def = builderTriggerToDef({
			...emptyBuilderTrigger(),
			kind: TriggerKind.Time,
			timePreset: TimePreset.Monthly,
		});
		expect(builderTriggerFromDef(def).timePreset).toBe(TimePreset.Monthly);
	});

	it("defaults a missing Time recurrence to daily", () => {
		const back = builderTriggerFromDef({ kind: TriggerKind.Time, config: {}, enabled: true });
		expect(back.timePreset).toBe(TimePreset.Daily);
	});
});

describe("triggerTypeSuggestions (Mailbox-8)", () => {
	it("always offers Email/v1 so email-triage is authorable on an empty vault", () => {
		expect(triggerTypeSuggestions([])).toContain("brainstorm/Email/v1");
		expect(SUGGESTED_TRIGGER_TYPES).toContain("brainstorm/Email/v1");
	});

	it("unions vault-present types with the curated set, deduped and sorted", () => {
		const out = triggerTypeSuggestions([
			"brainstorm/Widget/v1",
			"brainstorm/Email/v1", // dup of a curated entry
			"brainstorm/Widget/v1", // dup of a vault entry
		]);
		expect(out).toContain("brainstorm/Widget/v1");
		expect(out.filter((t) => t === "brainstorm/Email/v1")).toHaveLength(1);
		expect(out.filter((t) => t === "brainstorm/Widget/v1")).toHaveLength(1);
		expect([...out]).toEqual([...out].sort((a, b) => a.localeCompare(b)));
	});

	it("drops empty / non-string entries", () => {
		const out = triggerTypeSuggestions(["", "brainstorm/Real/v1", undefined as unknown as string]);
		expect(out).toContain("brainstorm/Real/v1");
		expect(out).not.toContain("");
		expect(out.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
	});
});
