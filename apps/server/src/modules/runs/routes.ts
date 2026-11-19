import { Hono } from "hono";
import { z } from "zod";
import { jsonBodyLimit, validate } from "../../http.ts";
import { NewRun, RunId } from "./model.ts";
import type { Runs } from "./store.ts";

const RunParam = z.object({ runId: RunId });

export function runsRoute(runs: Runs) {
	return new Hono()
		.post("/", jsonBodyLimit, validate("json", NewRun), (c) =>
			c.json({ run: runs.start(c.req.valid("json")) }, 201),
		)
		.get("/:runId", validate("param", RunParam), (c) =>
			c.json({ run: runs.get(c.req.valid("param").runId) }, 200),
		);
}
