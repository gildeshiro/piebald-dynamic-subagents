#!/usr/bin/env node
// profiles.mjs — creates/edits/removes Piebald profiles via the legitimate API (WS).
// Does NOT hand-edit SQLite (that would desync the app's in-memory cache). Editing
// a profile FORKS the generation_config (copy-on-write) — Default remains intact.
//
// Reasoning is per-engine, within the profile (override_patches):
//   anthropic        -> { effort: "low|medium|high|max", thinking_mode? }
//   openai_responses -> { reasoning_effort: "low|medium|high|xhigh" }
//   google           -> { thinking_budget: <int> (-1 = dynamic) }
//
// CLI:
//   PIEBALD_WEB_TOKEN=... node control-plane/profiles.mjs list
//   ... profiles.mjs ensure <name> [--anth low|medium|high|max] [--oai low|medium|high|xhigh] [--google <int>]
//   ... profiles.mjs delete <profile_id>

import { PiebaldWS, getToken } from "./ws-client.mjs";

export async function listProfiles(pb) { return (await pb.call("list_profiles")).profiles; }

export async function createProfile(pb, name) {
  const r = await pb.call("create_profile", { name });
  return r.profile.id;
}

// builds the override_patches map from a per-engine effort spec
export function buildOverridePatches({ anthropic_effort, thinking_mode, openai_reasoning_effort, google_thinking_budget } = {}) {
  const p = {};
  if (anthropic_effort || thinking_mode) {
    p.anthropic = { engine_type: "anthropic", data: { ...(anthropic_effort ? { effort: anthropic_effort } : {}), ...(thinking_mode ? { thinking_mode } : {}) } };
  }
  if (openai_reasoning_effort) p.openai_responses = { engine_type: "openai_responses", data: { reasoning_effort: openai_reasoning_effort } };
  if (google_thinking_budget != null) p.google = { engine_type: "google", data: { thinking_budget: google_thinking_budget } };
  return p;
}

// applies overrides (forks the config). No-op if there is nothing to set.
export async function setProfileOverrides(pb, profile_id, spec) {
  const override_patches = buildOverridePatches(spec);
  if (!Object.keys(override_patches).length) return { success: true, noop: true };
  return pb.call("update_profile_config", { profile_id, override_patches });
}

export async function deleteProfile(pb, profile_id) { return pb.call("delete_profile", { profile_id }); }

// creates-or-reuses a profile with the desired reasoning. Returns profile_id.
export async function ensureProfile(pb, spec) {
  const { name } = spec;
  const existing = (await listProfiles(pb)).find((p) => p.name === name);
  if (existing) return existing.id;
  const id = await createProfile(pb, name);
  await setProfileOverrides(pb, id, spec);
  return id;
}

// ---------- CLI ----------
const isMain = process.argv[1]?.endsWith("profiles.mjs");
if (isMain) {
  const [, , cmd, arg] = process.argv;
  const flag = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; };
  const pb = new PiebaldWS(getToken());
  await pb.connect();
  try {
    if (cmd === "list") {
      for (const p of await listProfiles(pb)) console.log(p.id, p.name, `(config ${p.config_id})`);
    } else if (cmd === "ensure") {
      const id = await ensureProfile(pb, {
        name: arg,
        anthropic_effort: flag("--anth"),
        openai_reasoning_effort: flag("--oai"),
        google_thinking_budget: flag("--google") != null ? Number(flag("--google")) : undefined,
      });
      console.log(JSON.stringify({ profile_id: id, name: arg }));
    } else if (cmd === "delete") {
      console.log(JSON.stringify(await deleteProfile(pb, Number(arg))));
    } else {
      console.log("usage: list | ensure <name> [--anth ..] [--oai ..] [--google <int>] | delete <id>");
    }
  } finally { pb.close(); }
}
