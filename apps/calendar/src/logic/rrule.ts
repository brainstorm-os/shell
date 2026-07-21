/**
 * RRULE ↔ structured `Recurrence` conversion now lives in `@brainstorm-os/sdk-types`
 * (the single shared parser/serializer for Calendar + Automations + future
 * consumers). Re-exported here so the existing `./rrule` imports (ics codec,
 * tests) keep working.
 */

export { recurrenceToRRule, rruleToRecurrence, stripRRulePrefix } from "@brainstorm-os/sdk-types";
