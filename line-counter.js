#!/usr/bin/env node
"use strict";

const http = require("http");
const url = require("url");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

const VERSION = "1.0.0";

const DEFAULT_IGNORE_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", ".vscode", "coverage",
	".turbo", ".cache", "out", "target", ".idea", ".pnpm", ".yarn"
]);

const LANG = {
	".js":  { name: "JavaScript", line: ["//"], block: [{ start: "/*", end: "*/", jsdoc: true }] },
	".jsx": { name: "React (JSX)", line: ["//"], block: [{ start: "/*", end: "*/", jsdoc: true }] },
	".ts":  { name: "TypeScript", line: ["//"], block: [{ start: "/*", end: "*/", jsdoc: true }] },
	".tsx": { name: "React (TSX)", line: ["//"], block: [{ start: "/*", end: "*/", jsdoc: true }] },
	".css": { name: "CSS", line: [], block: [{ start: "/*", end: "*/" }] },
	".html":{ name: "HTML", line: [], block: [{ start: "<!--", end: "-->" }] },
	".sql": { name: "SQL", line: ["--"], block: [{ start: "/*", end: "*/" }] },
	".prisma": { name: "Prisma", line: ["//"], block: [{ start: "/*", end: "*/" }] },
	".json": { name: "JSON", line: [], block: [] },
	".md": { name: "Markdown", line: [], block: [] },
	".yml": { name: "YAML", line: ["#"], block: [] },
	".yaml": { name: "YAML", line: ["#"], block: [] },
	".sh": { name: "Shell", line: ["#"], block: [] },
	".py": { name: "Python", line: ["#"], block: [] },
	".go": { name: "Go", line: ["//"], block: [{ start: "/*", end: "*/" }] },
	".java": { name: "Java", line: ["//"], block: [{ start: "/*", end: "*/", jsdoc: true }] },
	".c": { name: "C", line: ["//"], block: [{ start: "/*", end: "*/" }] },
	".cpp": { name: "C++", line: ["//"], block: [{ start: "/*", end: "*/" }] },
	".h": { name: "C/C++ Header", line: ["//"], block: [{ start: "/*", end: "*/" }] },
	".hpp": { name: "C++ Header", line: ["//"], block: [{ start: "/*", end: "*/" }] },
	".rs": { name: "Rust", line: ["//"], block: [{ start: "/*", end: "*/" }] },
};

function nowISO() { return new Date().toISOString(); }
function normalizeRel(p) { return p.split(path.sep).join("/"); }

function makeStats() {
	return { physical: 0, blank: 0, commentOnly: 0, codeOnly: 0, mixed: 0, code: 0, comments: 0 };
}
function addStats(dst, inc) {
	dst.physical += inc.physical;
	dst.blank += inc.blank;
	dst.commentOnly += inc.commentOnly;
	dst.codeOnly += inc.codeOnly;
	dst.mixed += inc.mixed;
	dst.code += inc.code;
	dst.comments += inc.comments;
}

function parseSize(str) {
	const s = String(str).trim().toLowerCase();
	const m = s.match(/^(\d+)(b|kb|k|mb|m|gb|g)?$/);
	if (!m) return Number(s) || 0;
	const n = Number(m[1]);
	const u = m[2] || "b";
	const mult = (u === "b") ? 1 :
		(u === "k" || u === "kb") ? 1024 :
		(u === "m" || u === "mb") ? 1024 * 1024 :
		(u === "g" || u === "gb") ? 1024 * 1024 * 1024 : 1;
	return n * mult;
}

function parseArgs(argv) {
	const args = {
		roots: [],
		port: 3500,
		autoPort: true,
		autoPortMaxTries: 50,
		concurrency: 32,
		maxBytes: 10 * 1024 * 1024,
		largeFileLines: 500,
		ignoreDirs: new Set(DEFAULT_IGNORE_DIRS),
		onlyExt: null,
		snapshotDir: ".audit-snapshots",
	};

	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root" && argv[i + 1]) args.roots.push(argv[++i]);
		else if (a === "--port" && argv[i + 1]) args.port = Number(argv[++i]) || args.port;
		else if (a === "--noAutoPort") args.autoPort = false;
		else if (a === "--concurrency" && argv[i + 1]) args.concurrency = Math.max(1, Number(argv[++i]) || args.concurrency);
		else if (a === "--maxBytes" && argv[i + 1]) args.maxBytes = parseSize(argv[++i]) || args.maxBytes;
		else if (a === "--largeLines" && argv[i + 1]) args.largeFileLines = Math.max(1, Number(argv[++i]) || args.largeFileLines);
		else if (a === "--ignore" && argv[i + 1]) {
			const parts = argv[++i].split(",").map(x => x.trim()).filter(Boolean);
			for (const p of parts) args.ignoreDirs.add(p);
		}
		else if (a === "--onlyExt" && argv[i + 1]) {
			const parts = argv[++i].split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
			args.onlyExt = new Set(parts.map(x => x.startsWith(".") ? x : "." + x));
		}
		else if (a === "--snapshotDir" && argv[i + 1]) args.snapshotDir = argv[++i];
	}

	if (args.roots.length === 0) args.roots.push(process.cwd());
	args.roots = args.roots.map(r => path.resolve(r));
	args.snapshotDir = path.resolve(process.cwd(), args.snapshotDir);
	return args;
}

class Semaphore {
	constructor(max) { this.max = max; this.active = 0; this.queue = []; }
	acquire() {
		return new Promise((resolve) => {
			const tryNow = () => {
				if (this.active < this.max) {
					this.active++;
					resolve(() => {
						this.active--;
						const next = this.queue.shift();
						if (next) next();
					});
				} else this.queue.push(tryNow);
			};
			tryNow();
		});
	}
}

async function ensureDir(dir) {
	try { await fsp.mkdir(dir, { recursive: true }); } catch {}
}

async function isProbablyBinary(filePath) {
	let fh;
	try {
		fh = await fsp.open(filePath, "r");
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
		return false;
	} catch {
		return true;
	} finally {
		try { await fh?.close(); } catch {}
	}
}

function detectDebtTokens(text) {
	const tokens = ["TODO", "FIXME", "HACK", "XXX", "BUG", "NOTE"];
	const hits = [];
	for (const t of tokens) {
		const re = new RegExp("\\b" + t + "\\b\\s*:|\\b" + t + "\\b\\s+|\\[" + t + "\\]", "i");
		if (re.test(text)) hits.push(t.toUpperCase());
	}
	return hits;
}

function detectRiskTokens(codeLine) {
	const rules = [
		{ k: "eval", re: /\beval\s*\(/ },
		{ k: "newFunction", re: /\bnew\s+Function\s*\(/ },
		{ k: "child_process", re: /\bchild_process\b|\brequire\s*\(\s*['"]child_process['"]\s*\)/ },
		{ k: "exec", re: /\bexec(File)?\s*\(/ },
		{ k: "rmrf", re: /\brm\s+-rf\b|rmSync\s*\(|rimraf\b/ },
		{ k: "sqlRaw", re: /\bqueryRaw\b|\bexecuteRaw\b|SELECT\s+.+\+|INSERT\s+.+\+/i },
	];
	const hits = [];
	for (const r of rules) if (r.re.test(codeLine)) hits.push(r.k);
	return hits;
}

function analyzeLineCStyle(line, rules, state) {
	let i = 0;
	let hasCode = false;
	let hasComment = false;

	const lineMarkers = rules.line || [];
	const blockMarkers = rules.block || [];

	while (i < line.length) {
		if (state.inBlock) {
			hasComment = true;
			const end = state.inBlock.end;
			const idx = line.indexOf(end, i);
			if (idx === -1) { i = line.length; break; }
			i = idx + end.length;
			state.inBlock = null;
			continue;
		}

		if (state.strQuote) {
			hasCode = true;
			const q = state.strQuote;
			if (q === "`") {
				if (line[i] === "`") { state.strQuote = null; i++; continue; }
				i++;
				continue;
			} else {
				if (line[i] === "\\") { i += 2; continue; }
				if (line[i] === q) { state.strQuote = null; i++; continue; }
				i++;
				continue;
			}
		}

		const ch = line[i];

		if (ch === "'" || ch === '"' || ch === "`") {
			hasCode = true;
			state.strQuote = ch;
			i++;
			continue;
		}

		let matchedLine = null;
		for (const lm of lineMarkers) {
			if (lm && line.startsWith(lm, i)) { matchedLine = lm; break; }
		}
		if (matchedLine) { hasComment = true; break; }

		let matchedBlock = null;
		for (const bm of blockMarkers) {
			if (bm && bm.start && bm.end && line.startsWith(bm.start, i)) { matchedBlock = bm; break; }
		}
		if (matchedBlock) {
			hasComment = true;
			state.inBlock = { end: matchedBlock.end, jsdoc: !!matchedBlock.jsdoc };
			i += matchedBlock.start.length;
			continue;
		}

		if (ch.trim() === "") { i++; continue; }
		hasCode = true;
		i++;
	}

	return { hasCode, hasComment };
}

function updateHeuristics(heur, codeLine) {
	if (/\bimport\s+/.test(codeLine) || /\brequire\s*\(/.test(codeLine)) heur.imports++;
	if (/\bexport\s+/.test(codeLine) || /\bmodule\.exports\b/.test(codeLine)) heur.exports++;
	if (/\bclass\s+\w+/.test(codeLine)) heur.classes++;
	if (/\bfunction\s+\w+\s*\(/.test(codeLine)) heur.functions++;
	if (/=>/.test(codeLine)) heur.arrows++;
}

function isMinifiedHeuristic(meta) {
	return meta.maxLineLen >= 2000 || meta.avgLineLen >= 250 || meta.whitespaceRatio <= 0.08;
}

async function analyzeFile(filePath, rules, cfg) {
	const st = makeStats();
	const debt = { TODO: 0, FIXME: 0, HACK: 0, XXX: 0, BUG: 0, NOTE: 0, JSDOC: 0 };
	const risk = { eval: 0, newFunction: 0, child_process: 0, exec: 0, rmrf: 0, sqlRaw: 0 };
	const heur = { imports: 0, exports: 0, functions: 0, arrows: 0, classes: 0 };

	let sizeBytes = 0;
	try {
		const s = await fsp.stat(filePath);
		sizeBytes = s.size;
		if (cfg.maxBytes && s.size > cfg.maxBytes) {
			return { skipped: true, skippedReason: "maxBytes(" + cfg.maxBytes + ")", sizeBytes, stats: st, debt, risk, heur, hash: null, minified: false, meta: null };
		}
	} catch {
		return { skipped: true, skippedReason: "stat_failed", sizeBytes, stats: st, debt, risk, heur, hash: null, minified: false, meta: null };
	}

	if (await isProbablyBinary(filePath)) {
		return { skipped: true, skippedReason: "binary_or_unreadable", sizeBytes, stats: st, debt, risk, heur, hash: null, minified: false, meta: null };
	}

	const state = { inBlock: null, strQuote: null };
	const hasher = crypto.createHash("sha1");

	let maxLineLen = 0;
	let sumLineLen = 0;
	let wsCount = 0;
	let chCount = 0;
	let nonEmpty = 0;

	try {
		const stream = fs.createReadStream(filePath, { encoding: "utf8" });
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		for await (const line of rl) {
			st.physical++;

			hasher.update(line);
			hasher.update("\n");

			const trimmed = line.trim();
			const len = line.length;
			maxLineLen = Math.max(maxLineLen, len);
			sumLineLen += len;

			for (let i = 0; i < line.length; i++) {
				const c = line[i];
				chCount++;
				if (c === " " || c === "\t") wsCount++;
			}

			if (trimmed === "") { st.blank++; continue; }
			nonEmpty++;

			let parsed;
			if ((!rules.line || rules.line.length === 0) && (!rules.block || rules.block.length === 0)) {
				parsed = { hasCode: true, hasComment: false };
			} else {
				parsed = analyzeLineCStyle(line, rules, state);
			}

			if (parsed.hasComment || state.inBlock) {
				const hits = detectDebtTokens(line);
				for (const h of hits) debt[h] = (debt[h] || 0) + 1;
				if (line.trim().startsWith("/**")) debt.JSDOC++;
			}

			if (parsed.hasCode) {
				const riskHits = detectRiskTokens(line);
				for (const k of riskHits) risk[k] = (risk[k] || 0) + 1;
				updateHeuristics(heur, line);
			}

			if (parsed.hasCode && parsed.hasComment) st.mixed++;
			else if (parsed.hasCode) st.codeOnly++;
			else if (parsed.hasComment) st.commentOnly++;
			else st.codeOnly++;
		}
	} catch {
		return { skipped: true, skippedReason: "read_failed", sizeBytes, stats: st, debt, risk, heur, hash: null, minified: false, meta: null };
	}

	st.code = st.codeOnly + st.mixed;
	st.comments = st.commentOnly + st.mixed;

	const meta = {
		maxLineLen: maxLineLen,
		avgLineLen: st.physical ? (sumLineLen / st.physical) : 0,
		whitespaceRatio: chCount ? (wsCount / chCount) : 0,
		nonEmpty: nonEmpty
	};

	const minified = isMinifiedHeuristic(meta);
	const hash = hasher.digest("hex");

	return { skipped: false, skippedReason: null, sizeBytes, stats: st, debt, risk, heur, hash, minified, meta };
}

async function collectFiles(rootAbs, cfg) {
	const files = [];
	const stack = [rootAbs];

	while (stack.length) {
		const dir = stack.pop();
		let dh;
		try { dh = await fsp.opendir(dir); } catch { continue; }

		for await (const dirent of dh) {
			const full = path.join(dir, dirent.name);

			if (dirent.isDirectory()) {
				if (!cfg.ignoreDirs.has(dirent.name)) stack.push(full);
				continue;
			}
			if (!dirent.isFile()) continue;

			const ext = path.extname(dirent.name).toLowerCase();
			if (!LANG[ext]) continue;
			if (cfg.onlyExt && !cfg.onlyExt.has(ext)) continue;

			files.push({ fullPath: full, ext: ext });
		}
	}

	return files;
}

function topN(arr, n, keyFn) {
	return [...arr].sort((a, b) => keyFn(b) - keyFn(a)).slice(0, n);
}

function buildDirAncestors(relDir) {
	const parts = relDir.split("/").filter(Boolean);
	const out = [];
	let cur = "";
	for (const part of parts) {
		cur = cur ? (cur + "/" + part) : part;
		out.push(cur);
	}
	return out;
}

function safeId(name) {
	return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function saveSnapshot(cfg, report) {
	await ensureDir(cfg.snapshotDir);
	const ts = new Date();
	const stamp =
		ts.getFullYear().toString().padStart(4, "0") +
		"-" + String(ts.getMonth() + 1).padStart(2, "0") +
		"-" + String(ts.getDate()).padStart(2, "0") +
		"_" + String(ts.getHours()).padStart(2, "0") +
		"-" + String(ts.getMinutes()).padStart(2, "0") +
		"-" + String(ts.getSeconds()).padStart(2, "0");

	const id = stamp + "__" + crypto.randomBytes(3).toString("hex");
	const file = path.join(cfg.snapshotDir, safeId(id) + ".json");
	await fsp.writeFile(file, JSON.stringify(report), "utf8");
	return { id: id, file: file };
}

async function listSnapshots(cfg) {
	await ensureDir(cfg.snapshotDir);
	const files = await fsp.readdir(cfg.snapshotDir).catch(() => []);
	const snaps = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const full = path.join(cfg.snapshotDir, f);
		try {
			const st = await fsp.stat(full);
			snaps.push({ id: f.replace(/\.json$/, ""), file: full, mtimeMs: st.mtimeMs, sizeBytes: st.size });
		} catch {}
	}
	snaps.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return snaps;
}

async function readSnapshot(cfg, id) {
	const file = path.join(cfg.snapshotDir, safeId(id) + ".json");
	const txt = await fsp.readFile(file, "utf8");
	return JSON.parse(txt);
}

function diffReports(a, b) {
	const out = {
		from: a.generatedAt, to: b.generatedAt,
		delta: {
			code: (b.summary?.totals?.code || 0) - (a.summary?.totals?.code || 0),
			physical: (b.summary?.totals?.physical || 0) - (a.summary?.totals?.physical || 0),
			comments: (b.summary?.totals?.comments || 0) - (a.summary?.totals?.comments || 0),
			filesAnalyzed: (b.summary?.filesAnalyzed || 0) - (a.summary?.filesAnalyzed || 0),
			filesSkipped: (b.summary?.filesSkipped || 0) - (a.summary?.filesSkipped || 0),
			minifiedFiles: (b.summary?.minifiedFiles || 0) - (a.summary?.minifiedFiles || 0),
			duplicateGroups: (b.summary?.duplicateGroups || 0) - (a.summary?.duplicateGroups || 0),
		},
		byLanguage: [],
		debt: {},
		risk: {},
	};

	const langs = new Set([ ...Object.keys(a.byLanguage || {}), ...Object.keys(b.byLanguage || {}) ]);
	for (const l of langs) {
		const ac = a.byLanguage?.[l]?.code || 0;
		const bc = b.byLanguage?.[l]?.code || 0;
		const d = bc - ac;
		if (d !== 0) out.byLanguage.push({ language: l, deltaCode: d });
	}
	out.byLanguage.sort((x, y) => Math.abs(y.deltaCode) - Math.abs(x.deltaCode));

	const debtKeys = new Set([ ...Object.keys(a.debt || {}), ...Object.keys(b.debt || {}) ]);
	for (const k of debtKeys) out.debt[k] = (b.debt?.[k] || 0) - (a.debt?.[k] || 0);

	const riskKeys = new Set([ ...Object.keys(a.riskTotals || {}), ...Object.keys(b.riskTotals || {}) ]);
	for (const k of riskKeys) out.risk[k] = (b.riskTotals?.[k] || 0) - (a.riskTotals?.[k] || 0);

	return out;
}

function median(nums) {
	if (!nums.length) return 0;
	const a = [...nums].sort((x, y) => x - y);
	const mid = Math.floor(a.length / 2);
	return (a.length % 2) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function bucketize(value, edges) {
	for (let i = 0; i < edges.length; i++) {
		if (value <= edges[i]) return i;
	}
	return edges.length;
}

async function scanAll(cfg, progressCb = null) {
	const started = Date.now();
	const sem = new Semaphore(cfg.concurrency);

	const report = {
		generatedAt: nowISO(),
		durationMs: 0,
		version: VERSION,
		config: {
			roots: cfg.roots,
			concurrency: cfg.concurrency,
			maxBytes: cfg.maxBytes,
			largeLines: cfg.largeFileLines,
			ignoreDirs: [...cfg.ignoreDirs],
			onlyExt: cfg.onlyExt ? [...cfg.onlyExt] : null,
			snapshotDir: cfg.snapshotDir,
		},
		summary: {
			totals: makeStats(),
			filesAnalyzed: 0,
			filesSkipped: 0,
			totalSizeBytes: 0,
			minifiedFiles: 0,
			duplicateGroups: 0,
			duplicateFiles: 0,
			ratios: { commentDensity: 0, blankRatio: 0 },
			central: { avgFileLOC: 0, medianFileLOC: 0, avgFileCode: 0, medianFileCode: 0 },
		},
		byLanguage: {},
		byProject: {},
		byDir: {},
		topDirsByCode: [],
		topFilesByCode: [],
		debtTopFiles: [],
		riskTopFiles: [],
		files: [],
		debt: { TODO: 0, FIXME: 0, HACK: 0, XXX: 0, BUG: 0, NOTE: 0, JSDOC: 0 },
		riskTotals: { eval: 0, newFunction: 0, child_process: 0, exec: 0, rmrf: 0, sqlRaw: 0 },
		duplicates: [],
		distributions: {
			locEdges: [50, 200, 500, 1000, 2000],
			locBuckets: [],
			commentDensityBuckets: [],
		}
	};

	let allFiles = [];
	for (const rootAbs of cfg.roots) {
		const projectName = path.basename(rootAbs) || normalizeRel(rootAbs);
		if (progressCb) progressCb({ phase: "collect", project: projectName });
		const files = await collectFiles(rootAbs, cfg);
		allFiles.push(...files.map(f => ({ ...f, rootAbs: rootAbs, projectName: projectName })));
	}

	let done = 0;
	const total = allFiles.length;

	const hashMap = new Map();
	const fileLocs = [];
	const fileCodes = [];

	const tasks = allFiles.map(async (f) => {
		const release = await sem.acquire();
		try {
			const rules = LANG[f.ext];
			const langName = rules.name;

			const analyzed = await analyzeFile(f.fullPath, rules, cfg);

			const relToProject = normalizeRel(path.relative(f.rootAbs, f.fullPath));
			const fileDirRel = normalizeRel(path.dirname(relToProject)).replace(/^\.$/, "");
			const projectKey = f.projectName;

			const fileRec = {
				project: projectKey,
				path: relToProject,
				dir: fileDirRel,
				ext: f.ext,
				language: langName,
				sizeBytes: analyzed.sizeBytes || 0,
				skipped: analyzed.skipped,
				skippedReason: analyzed.skippedReason || null,
				stats: analyzed.stats,
				debt: analyzed.debt,
				risk: analyzed.risk,
				heur: analyzed.heur,
				hash: analyzed.hash,
				minified: analyzed.minified,
				meta: analyzed.meta,
			};

			report.files.push(fileRec);
			report.summary.totalSizeBytes += fileRec.sizeBytes;

			if (analyzed.skipped) {
				report.summary.filesSkipped++;
				return;
			}

			report.summary.filesAnalyzed++;
			addStats(report.summary.totals, analyzed.stats);

			fileLocs.push(analyzed.stats.physical);
			fileCodes.push(analyzed.stats.code);

			if (fileRec.minified) report.summary.minifiedFiles++;

			for (const k of Object.keys(report.debt)) report.debt[k] += (analyzed.debt?.[k] || 0);
			for (const k of Object.keys(report.riskTotals)) report.riskTotals[k] += (analyzed.risk?.[k] || 0);

			if (!report.byLanguage[langName]) report.byLanguage[langName] = makeStats();
			addStats(report.byLanguage[langName], analyzed.stats);

			if (!report.byProject[projectKey]) report.byProject[projectKey] = makeStats();
			addStats(report.byProject[projectKey], analyzed.stats);

			const baseDirKey = projectKey + (fileDirRel ? ("/" + fileDirRel) : "");
			if (!report.byDir[projectKey]) report.byDir[projectKey] = makeStats();
			addStats(report.byDir[projectKey], analyzed.stats);

			for (const d of buildDirAncestors(baseDirKey)) {
				if (!report.byDir[d]) report.byDir[d] = makeStats();
				addStats(report.byDir[d], analyzed.stats);
			}

			if (fileRec.hash) {
				const entry = hashMap.get(fileRec.hash) || { sizeBytes: fileRec.sizeBytes, list: [] };
				entry.list.push({ project: projectKey, path: relToProject, sizeBytes: fileRec.sizeBytes });
				hashMap.set(fileRec.hash, entry);
			}

		} finally {
			done++;
			if (progressCb && (done % 25 === 0 || done === total)) progressCb({ phase: "analyze", done: done, total: total });
			release();
		}
	});

	await Promise.all(tasks);

	const analyzable = report.files.filter(f => !f.skipped);

	report.topFilesByCode = topN(analyzable, 30, x => x.stats.code).map(f => ({
		project: f.project, path: f.path,
		code: f.stats.code, comments: f.stats.comments, lines: f.stats.physical,
		minified: !!f.minified
	}));

	const dirsArr = Object.entries(report.byDir).map(([k, v]) => ({ dir: k, ...v }));
	report.topDirsByCode = topN(dirsArr, 12, x => x.code);

	const debtScore = (f) => Object.values(f.debt || {}).reduce((a, b) => a + (b || 0), 0);
	const riskScore = (f) => Object.values(f.risk || {}).reduce((a, b) => a + (b || 0), 0);

	report.debtTopFiles = topN(analyzable, 20, debtScore).map(f => ({
		project: f.project, path: f.path, debt: debtScore(f), code: f.stats.code
	}));
	report.riskTopFiles = topN(analyzable, 20, riskScore).map(f => ({
		project: f.project, path: f.path, risk: riskScore(f), code: f.stats.code
	}));

	const dupGroups = [];
	for (const [hash, info] of hashMap.entries()) {
		if (!info.list || info.list.length < 2) continue;
		dupGroups.push({ hash: hash, sizeBytes: info.sizeBytes, files: info.list });
	}
	dupGroups.sort((a, b) => (b.files.length * b.sizeBytes) - (a.files.length * a.sizeBytes));
	report.duplicates = dupGroups.slice(0, 200);
	report.summary.duplicateGroups = dupGroups.length;
	report.summary.duplicateFiles = dupGroups.reduce((acc, g) => acc + g.files.length, 0);

	const totals = report.summary.totals;
	const code = totals.code || 0;
	const comments = totals.comments || 0;
	const physical = totals.physical || 0;

	report.summary.ratios.commentDensity = code ? (comments / code) : 0;
	report.summary.ratios.blankRatio = physical ? (totals.blank / physical) : 0;

	report.summary.central.avgFileLOC = fileLocs.length ? (fileLocs.reduce((a, b) => a + b, 0) / fileLocs.length) : 0;
	report.summary.central.medianFileLOC = median(fileLocs);
	report.summary.central.avgFileCode = fileCodes.length ? (fileCodes.reduce((a, b) => a + b, 0) / fileCodes.length) : 0;
	report.summary.central.medianFileCode = median(fileCodes);

	const locEdges = report.distributions.locEdges;
	const locBuckets = new Array(locEdges.length + 1).fill(0);
	const cdBuckets = new Array(6).fill(0);

	for (const f of analyzable) {
		const L = f.stats.physical || 0;
		locBuckets[bucketize(L, locEdges)]++;

		const c = f.stats.comments || 0;
		const k = f.stats.code || 0;
		const d = k ? (c / k) : (c ? 10 : 0);

		if (d <= 0) cdBuckets[0]++;
		else if (d <= 0.02) cdBuckets[1]++;
		else if (d <= 0.08) cdBuckets[2]++;
		else if (d <= 0.15) cdBuckets[3]++;
		else if (d <= 0.30) cdBuckets[4]++;
		else cdBuckets[5]++;
	}

	report.distributions.locBuckets = locBuckets;
	report.distributions.commentDensityBuckets = cdBuckets;

	report.durationMs = Date.now() - started;
	return report;
}

function sumObj(o) {
	let s = 0;
	for (const k in (o || {})) s += (o[k] || 0);
	return s;
}

function minFileShape(f) {
	return {
		project: f.project,
		path: f.path,
		dir: f.dir || "",
		ext: f.ext,
		language: f.language,
		sizeBytes: f.sizeBytes,
		skipped: f.skipped,
		skippedReason: f.skippedReason,
		minified: !!f.minified,
		stats: f.stats,
		debt: f.debt,
		risk: f.risk,
		heur: f.heur,
		meta: f.meta,
	};
}

function filterAndPageFiles(report, q) {
	const page = Math.max(1, Number(q.page || 1) || 1);
	const pageSize = Math.min(5000, Math.max(10, Number(q.pageSize || 200) || 200));

	const project = q.project ? String(q.project) : null;
	const dir = (q.dir !== undefined) ? String(q.dir) : null;

	const includeSub = true; // siempre ON
	const search = q.q ? String(q.q).toLowerCase() : null;

	const onlyMinified = q.minified === "1";
	const onlyLowComments = q.lowComments === "1";

	const sort = q.sort ? String(q.sort) : "code";
	const order = (q.order === "asc") ? 1 : -1;

	let arr = report.files || [];
	if (project) arr = arr.filter(f => f.project === project);

	if (dir !== null) {
		if (!dir) {
			// root
		} else {
			if (includeSub) arr = arr.filter(f => (f.dir || "") === dir || (f.dir || "").startsWith(dir + "/"));
			else arr = arr.filter(f => (f.dir || "") === dir);
		}
	}

	if (onlyMinified) arr = arr.filter(f => !!f.minified);

	if (search) {
		arr = arr.filter(f =>
			(f.project + "/" + f.path).toLowerCase().includes(search) ||
			(f.language || "").toLowerCase().includes(search) ||
			(f.ext || "").toLowerCase().includes(search)
		);
	}

	if (onlyLowComments) {
		arr = arr.filter(f => {
			if (f.skipped) return false;
			const code = f.stats?.code || 0;
			const comm = f.stats?.comments || 0;
			const density = code ? (comm / code) : 0;
			return density <= 0.02;
		});
	}

	const keyFn = (f) => {
		if (sort === "lines") return f.stats?.physical || 0;
		if (sort === "comments") return f.stats?.comments || 0;
		if (sort === "density") {
			const code = f.stats?.code || 0;
			const comm = f.stats?.comments || 0;
			return code ? (comm / code) : 0;
		}
		if (sort === "debt") return sumObj(f.debt);
		if (sort === "risk") return sumObj(f.risk);
		if (sort === "size") return f.sizeBytes || 0;
		if (sort === "path") return (f.project + "/" + f.path).toLowerCase();
		return f.stats?.code || 0;
	};

	arr = [...arr].sort((a, b) => {
		const ka = keyFn(a);
		const kb = keyFn(b);
		if (typeof ka === "string" && typeof kb === "string") return ka.localeCompare(kb) * order;
		return (kb - ka) * order;
	});

	const total = arr.length;

	const all = q.all === "1";
	if (all) {
		const cap = Math.max(1000, Math.min(20000, Number(q.cap || 20000) || 20000));
		const take = Math.min(total, cap);
		const items = arr.slice(0, take).map(minFileShape);
		return { page: 1, pageSize: take, total: total, capped: take < total, items: items };
	}

	const start = (page - 1) * pageSize;
	const items = arr.slice(start, start + pageSize).map(minFileShape);
	return { page: page, pageSize: pageSize, total: total, items: items };
}

function getDirChildren(report, project, dir) {
	const childrenDirs = new Map();
	const files = { count: 0, stats: makeStats() };

	for (const f of report.files || []) {
		if (f.project !== project) continue;
		if (f.skipped) continue;

		const fdir = f.dir || "";
		if (dir && fdir !== dir && !fdir.startsWith(dir + "/")) continue;

		const rel = dir ? fdir.slice(dir.length).replace(/^\//, "") : fdir;

		if (rel === "") {
			files.count++;
			addStats(files.stats, f.stats);
		} else {
			const first = rel.split("/")[0];
			const childKey = dir ? (dir + "/" + first) : first;
			if (!childrenDirs.has(childKey)) childrenDirs.set(childKey, makeStats());
			addStats(childrenDirs.get(childKey), f.stats);
		}
	}

	const dirsArr = [...childrenDirs.entries()].map(([k, v]) => ({ dir: k, ...v }));
	dirsArr.sort((a, b) => b.code - a.code);

	return { project: project, dir: dir || "", files: files, dirs: dirsArr };
}

function toCSV(rows, headers) {
	const esc = (v) => {
		const s = String(v ?? "");
		if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
		return s;
	};
	const out = [];
	out.push(headers.map(esc).join(","));
	for (const r of rows) out.push(headers.map(h => esc(r[h])).join(","));
	return out.join("\n");
}

function htmlPage() {
	const H = [];
	H.push('<!doctype html>');
	H.push('<html lang="es">');
	H.push('<head>');
	H.push('  <meta charset="utf-8"/>');
	H.push('  <meta name="viewport" content="width=device-width,initial-scale=1"/>');
	H.push('  <title>Code Audit Dashboard</title>');
	H.push('  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>');
	H.push('  <style>');
	H.push('    :root{');
	H.push('      --bg:#07090c; --bg2:#0b0e12; --panel:#0b0f14; --panel2:#0a0d12;');
	H.push('      --line:rgba(255,255,255,.08); --line2:rgba(255,255,255,.05);');
	H.push('      --text:rgba(255,255,255,.90); --muted:rgba(255,255,255,.55);');
	H.push('      --cyan:#22d3ee; --purple:#a78bfa; --green:#34d399; --pink:#fb7185; --yellow:#facc15;');
	H.push('      --shadow: 0 18px 40px rgba(0,0,0,.55);');
	H.push('      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;');
	H.push('      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Helvetica Neue", sans-serif;');
	H.push('    }');
	H.push('    *{box-sizing:border-box;}');
	H.push('    html,body{height:100%;}');
	H.push('    body{margin:0;font-family:var(--sans);color:var(--text);background:linear-gradient(180deg,var(--bg),var(--bg2));}');
	H.push('    body:before{content:"";position:fixed;inset:0;pointer-events:none;');
	H.push('      background-image:');
	H.push('        linear-gradient(to right, rgba(255,255,255,.05) 1px, transparent 1px),');
	H.push('        linear-gradient(to bottom, rgba(255,255,255,.05) 1px, transparent 1px);');
	H.push('      background-size: 84px 84px; opacity:.35; mix-blend-mode:screen;}');
	H.push('    .wrap{max-width:1260px;margin:0 auto;padding:18px;}');
	H.push('    .topbar{display:flex;gap:12px;align-items:center;justify-content:space-between;');
	H.push('      padding:12px 14px;border:1px solid var(--line);background:rgba(0,0,0,.35);box-shadow:var(--shadow);}');
	H.push('    .brand{display:flex;align-items:center;gap:12px;}');
	H.push('    .logo{width:38px;height:38px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;}');
	H.push('    .title{font-size:16px;letter-spacing:.5px;font-weight:600;}');
	H.push('    .subtitle{font-size:12px;color:var(--muted);margin-top:2px;}');
	H.push('    .status{font-size:12px;color:var(--muted);font-family:var(--mono);}');
	H.push('    .btn{border:1px solid var(--line);background:rgba(0,0,0,.45);color:var(--text);');
	H.push('      padding:9px 12px;font-size:12px;letter-spacing:.4px;text-transform:uppercase;cursor:pointer;}');
	H.push('    .btn:hover{border-color:rgba(255,255,255,.18);}');
	H.push('    .btn.primary{border-color:rgba(34,211,238,.55);box-shadow:0 0 0 1px rgba(34,211,238,.12) inset;}');
	H.push('    .btn.primary:hover{border-color:rgba(34,211,238,.9);}');
	H.push('    .btn.danger{border-color:rgba(251,113,133,.55);}');
	H.push('    .btn.danger:hover{border-color:rgba(251,113,133,.95);}');
	H.push('    .tabs{display:flex;gap:8px;margin-top:12px;}');
	H.push('    .tab{border:1px solid var(--line);background:rgba(0,0,0,.28);color:var(--muted);');
	H.push('      padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.4px;cursor:pointer;}');
	H.push('    .tab.active{color:var(--text);border-color:rgba(255,255,255,.18);}');
	H.push('    .grid{display:grid;gap:12px;margin-top:12px;}');
	H.push('    .cards{grid-template-columns:repeat(5,1fr);}');
	H.push('    @media(max-width:1050px){.cards{grid-template-columns:repeat(2,1fr);} }');
	H.push('    .card{border:1px solid var(--line);background:rgba(0,0,0,.30);padding:12px;min-height:74px;}');
	H.push('    .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.35px;}');
	H.push('    .v{font-size:20px;font-weight:650;margin-top:6px;font-family:var(--mono);}');
	H.push('    .s{font-size:12px;color:var(--muted);margin-top:6px;font-family:var(--mono);}');
	H.push('    .accent{display:inline-block;width:10px;height:10px;border:1px solid var(--line);margin-right:8px;vertical-align:middle;}');
	H.push('    .accent.c{background:rgba(34,211,238,.25);border-color:rgba(34,211,238,.5);}');
	H.push('    .accent.p{background:rgba(167,139,250,.25);border-color:rgba(167,139,250,.5);}');
	H.push('    .accent.g{background:rgba(52,211,153,.20);border-color:rgba(52,211,153,.45);}');
	H.push('    .accent.r{background:rgba(251,113,133,.20);border-color:rgba(251,113,133,.45);}');
	H.push('    .panel{border:1px solid var(--line);background:rgba(0,0,0,.26);padding:12px;}');
	H.push('    .panelHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}');
	H.push('    .panelTitle{font-size:12px;text-transform:uppercase;letter-spacing:.45px;color:rgba(255,255,255,.80);}');
	H.push('    .panelMeta{font-size:12px;color:var(--muted);font-family:var(--mono);}');
	H.push('    .row{display:grid;gap:12px;}');
	H.push('    .row.two{grid-template-columns:1fr 1fr;}');
	H.push('    @media(max-width:1050px){.row.two{grid-template-columns:1fr;} }');
	H.push('    .canvasBox{height:260px;border:1px solid var(--line2);background:rgba(0,0,0,.18);padding:8px;}');
	H.push('    .lists{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}');
	H.push('    @media(max-width:1050px){.lists{grid-template-columns:1fr;} }');
	H.push('    .list{border:1px solid var(--line2);background:rgba(0,0,0,.18);padding:10px;max-height:320px;overflow:auto;}');
	H.push('    .item{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid rgba(255,255,255,.06);}');
	H.push('    .item:first-child{border-top:none;}');
	H.push('    .item .name{font-family:var(--mono);font-size:12px;color:rgba(255,255,255,.88);}');
	H.push('    .item .num{font-family:var(--mono);font-size:12px;color:var(--muted);}');
	H.push('    .hidden{display:none !important;}');

	H.push('    /* Explorer */');
	H.push('    .explorer{display:grid;grid-template-columns:320px 1fr;gap:12px;}');
	H.push('    @media(max-width:1050px){.explorer{grid-template-columns:1fr;} }');
	H.push('    .toolrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}');
	H.push('    .input{border:1px solid var(--line);background:rgba(0,0,0,.45);color:var(--text);padding:9px 10px;font-size:12px;font-family:var(--mono);min-width:240px;}');
	H.push('    .pill{border:1px solid var(--line);background:rgba(0,0,0,.35);color:var(--muted);padding:8px 10px;font-size:12px;font-family:var(--mono);}');
	H.push('    .tree{border:1px solid var(--line2);background:rgba(0,0,0,.18);padding:8px;max-height:620px;overflow:auto;}');
	H.push('    .node{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 8px;border-top:1px solid rgba(255,255,255,.06);cursor:pointer;}');
	H.push('    .node:first-child{border-top:none;}');
	H.push('    .node:hover{background:rgba(255,255,255,.04);}');
	H.push('    .node .label{font-family:var(--mono);font-size:12px;color:rgba(255,255,255,.88);}');
	H.push('    .node .meta{font-family:var(--mono);font-size:12px;color:var(--muted);}');
	H.push('    table{width:100%;border-collapse:collapse;}');
	H.push('    thead th{position:sticky;top:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);border-bottom:1px solid rgba(255,255,255,.10);}');
	H.push('    th,td{padding:10px 10px;border-top:1px solid rgba(255,255,255,.06);font-size:12px;}');
	H.push('    td{font-family:var(--mono);color:rgba(255,255,255,.90);}');
	H.push('    td.num, th.num{text-align:right;}');
	H.push('    th{font-family:var(--mono);color:rgba(255,255,255,.75);text-transform:uppercase;letter-spacing:.35px;font-size:11px;cursor:pointer;user-select:none;}');
	H.push('    th:hover{color:rgba(255,255,255,.92);}');
	H.push('    tr.file:hover{background:rgba(255,255,255,.04);}');
	H.push('    .arrow{margin-left:6px;color:var(--cyan);}');
	H.push('    .badge{display:inline-block;border:1px solid rgba(255,255,255,.12);padding:2px 6px;margin-left:8px;color:var(--muted);}');
	H.push('    .badge.min{border-color:rgba(167,139,250,.55);color:rgba(167,139,250,.95);}');
	H.push('    .badge.skip{border-color:rgba(251,113,133,.55);color:rgba(251,113,133,.95);}');

	H.push('    /* Drawer */');
	H.push('    .drawerWrap{position:fixed;inset:0;display:none;z-index:99;}');
	H.push('    .drawerWrap.on{display:block;}');
	H.push('    .drawerBg{position:absolute;inset:0;background:rgba(0,0,0,.65);}');
	H.push('    .drawer{position:absolute;top:0;right:0;height:100%;width:min(520px, 94vw);background:rgba(8,10,14,.98);border-left:1px solid rgba(255,255,255,.10);padding:14px;overflow:auto;}');
	H.push('    .drawerTitle{font-size:12px;text-transform:uppercase;letter-spacing:.45px;color:rgba(255,255,255,.82);}');
	H.push('    .drawerPath{margin-top:8px;font-family:var(--mono);font-size:12px;color:rgba(255,255,255,.90);}');
	H.push('    .drawerRow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}');
	H.push('    .box{border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.25);padding:10px;}');
	H.push('    .box .k{font-size:11px;color:var(--muted);}');
	H.push('    .box .v{font-family:var(--mono);font-size:16px;margin-top:6px;}');
	H.push('    pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;color:rgba(255,255,255,.85);}');

	H.push('    /* Footer */');
	H.push('    .footer{margin-top:14px;color:rgba(255,255,255,.45);font-size:12px;font-family:var(--mono);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;}');
	H.push('  </style>');
	H.push('</head>');

	H.push('<body>');
	H.push('<div class="wrap">');

	H.push('  <div class="topbar">');
	H.push('    <div class="brand">');
	H.push('      <div class="logo">▦</div>');
	H.push('      <div>');
	H.push('        <div class="title">Code Audit Dashboard</div>');
	H.push('        <div class="subtitle">neon / grid / audit · v' + VERSION + '</div>');
	H.push('      </div>');
	H.push('    </div>');
	H.push('    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;">');
	H.push('      <div class="status" id="status">—</div>');
	H.push('      <button class="btn primary" id="btnScan">Rescan</button>');
	H.push('      <button class="btn" id="btnSnapshot">Snapshot</button>');
	H.push('      <a class="btn" href="/api/export.csv?scope=files">CSV</a>');
	H.push('    </div>');
	H.push('  </div>');

	H.push('  <div class="tabs">');
	H.push('    <button class="tab active" id="tabOverview">Overview</button>');
	H.push('    <button class="tab" id="tabExplorer">Explorer</button>');
	H.push('    <button class="tab" id="tabSnapshots">Snapshots</button>');
	H.push('  </div>');

	// Overview
	H.push('  <div id="viewOverview">');
	H.push('    <div class="grid cards">');
	H.push('      <div class="card"><div class="k"><span class="accent c"></span>Code</div><div class="v" id="mCode">—</div><div class="s" id="mCoverage">—</div></div>');
	H.push('      <div class="card"><div class="k"><span class="accent p"></span>Total lines</div><div class="v" id="mTotal">—</div><div class="s" id="mBlank">—</div></div>');
	H.push('      <div class="card"><div class="k"><span class="accent g"></span>Comments</div><div class="v" id="mComments">—</div><div class="s" id="mMedian">—</div></div>');
	H.push('      <div class="card"><div class="k"><span class="accent r"></span>Minified</div><div class="v" id="mMin">—</div><div class="s">heuristic</div></div>');
	H.push('      <div class="card"><div class="k"><span class="accent c"></span>Duplicates</div><div class="v" id="mDup">—</div><div class="s" id="mDupFiles">—</div></div>');
	H.push('    </div>');

	H.push('    <div class="grid row two">');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Languages (Code)</div><div class="panelMeta" id="metaGen">—</div></div>');
	H.push('        <div class="canvasBox"><canvas id="chartLang"></canvas></div>');
	H.push('      </div>');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Top directories (Code)</div><div class="panelMeta">bar</div></div>');
	H.push('        <div class="canvasBox"><canvas id="chartDirs"></canvas></div>');
	H.push('      </div>');
	H.push('    </div>');

	H.push('    <div class="grid row two">');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Projects (Code vs Comments)</div><div class="panelMeta">stack</div></div>');
	H.push('        <div class="canvasBox"><canvas id="chartProjects"></canvas></div>');
	H.push('      </div>');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Distributions</div><div class="panelMeta">LOC & coverage</div></div>');
	H.push('        <div class="row two">');
	H.push('          <div class="canvasBox" style="height:240px;"><canvas id="chartLOC"></canvas></div>');
	H.push('          <div class="canvasBox" style="height:240px;"><canvas id="chartCD"></canvas></div>');
	H.push('        </div>');
	H.push('      </div>');
	H.push('    </div>');

	H.push('    <div class="grid lists">');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Top files (Code)</div><div class="panelMeta"><button class="btn" id="qaLargest">Open in Explorer</button></div></div>');
	H.push('        <div class="list" id="listTopFiles"></div>');
	H.push('      </div>');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Debt hotspots</div><div class="panelMeta"><button class="btn" id="qaDebt">Explore</button></div></div>');
	H.push('        <div class="list" id="listDebt"></div>');
	H.push('      </div>');
	H.push('      <div class="panel">');
	H.push('        <div class="panelHead"><div class="panelTitle">Risk hotspots</div><div class="panelMeta"><button class="btn danger" id="qaRisk">Explore</button></div></div>');
	H.push('        <div class="list" id="listRisk"></div>');
	H.push('      </div>');
	H.push('    </div>');
	H.push('  </div>');

	// Explorer
	H.push('  <div id="viewExplorer" class="hidden">');
	H.push('    <div class="panel">');
	H.push('      <div class="panelHead">');
	H.push('        <div class="panelTitle">Explorer</div>');
	H.push('        <div class="panelMeta" id="explMeta">—</div>');
	H.push('      </div>');
	H.push('      <div class="toolrow" style="margin-bottom:10px;">');
	H.push('        <button class="btn" id="btnBack">Back</button>');
	H.push('        <button class="btn" id="btnUp">Up</button>');
	H.push('        <span class="pill" id="crumb">—</span>');
	H.push('        <span class="pill">Subfolders: ON</span>');
	H.push('        <input class="input" id="inpSearch" placeholder="Search (path / lang / ext)"/>');
	H.push('        <label class="pill" style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="chkLowComments"/> Low comments</label>');
	H.push('        <label class="pill" style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="chkMinified"/> Minified</label>');
	H.push('        <button class="btn" id="btnLoadAll">Load all</button>');
	H.push('      </div>');

	H.push('      <div class="explorer">');
	H.push('        <div class="tree" id="tree"></div>');
	H.push('        <div class="panel" style="padding:0;">');
	H.push('          <div style="max-height:620px;overflow:auto;">');
	H.push('            <table>');
	H.push('              <thead>');
	H.push('                <tr>');
	H.push('                  <th data-sort="path">File</th>');
	H.push('                  <th class="num" data-sort="code">Code</th>');
	H.push('                  <th class="num" data-sort="comments">Comments</th>');
	H.push('                  <th class="num" data-sort="lines">Total</th>');
	H.push('                  <th class="num" data-sort="density">Coverage</th>');
	H.push('                  <th class="num" data-sort="debt">Debt</th>');
	H.push('                  <th class="num" data-sort="risk">Risk</th>');
	H.push('                  <th class="num" data-sort="size">Size</th>');
	H.push('                </tr>');
	H.push('              </thead>');
	H.push('              <tbody id="tbl"></tbody>');
	H.push('            </table>');
	H.push('          </div>');
	H.push('          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.08);">');
	H.push('            <div class="panelMeta" id="pager">—</div>');
	H.push('            <div style="display:flex;gap:8px;">');
	H.push('              <button class="btn" id="prev">Prev</button>');
	H.push('              <button class="btn" id="next">Next</button>');
	H.push('            </div>');
	H.push('          </div>');
	H.push('        </div>');
	H.push('      </div>');
	H.push('    </div>');
	H.push('  </div>');

	// Snapshots
	H.push('  <div id="viewSnapshots" class="hidden">');
	H.push('    <div class="panel">');
	H.push('      <div class="panelHead"><div class="panelTitle">Snapshots</div><div class="panelMeta">diff + export</div></div>');
	H.push('      <div class="toolrow" style="margin-bottom:10px;">');
	H.push('        <button class="btn" id="btnRefreshSnaps">Refresh</button>');
	H.push('        <select class="input" id="selA" style="min-width:340px;"></select>');
	H.push('        <select class="input" id="selB" style="min-width:340px;"></select>');
	H.push('        <button class="btn primary" id="btnDiff">Diff</button>');
	H.push('      </div>');
	H.push('      <div class="panel" style="border-color:rgba(255,255,255,.06);background:rgba(0,0,0,.18);">');
	H.push('        <pre id="diffBox">Select two snapshots and press DIFF.</pre>');
	H.push('      </div>');
	H.push('    </div>');
	H.push('  </div>');

	// Drawer
	H.push('  <div class="drawerWrap" id="drawerWrap">');
	H.push('    <div class="drawerBg" id="drawerBg"></div>');
	H.push('    <div class="drawer">');
	H.push('      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">');
	H.push('        <div class="drawerTitle">Inspector</div>');
	H.push('        <button class="btn" id="drawerClose">Close</button>');
	H.push('      </div>');
	H.push('      <div class="drawerPath" id="dPath">—</div>');
	H.push('      <div class="drawerRow">');
	H.push('        <div class="box"><div class="k">Code</div><div class="v" id="dCode">—</div></div>');
	H.push('        <div class="box"><div class="k">Comments</div><div class="v" id="dComm">—</div></div>');
	H.push('        <div class="box"><div class="k">Total</div><div class="v" id="dTotal">—</div></div>');
	H.push('        <div class="box"><div class="k">Coverage</div><div class="v" id="dCov">—</div></div>');
	H.push('      </div>');
	H.push('      <div class="drawerRow" style="grid-template-columns:1fr;">');
	H.push('        <div class="box"><div class="k">Debt</div><pre id="dDebt"></pre></div>');
	H.push('        <div class="box"><div class="k">Risk</div><pre id="dRisk"></pre></div>');
	H.push('        <div class="box"><div class="k">Duplicates</div><pre id="dDup"></pre></div>');
	H.push('      </div>');
	H.push('    </div>');
	H.push('  </div>');

	H.push('  <div class="footer">');
	H.push('    <div>© Nubaro</div>');
	H.push('    <div style="display:flex;gap:14px;flex-wrap:wrap;">');
	H.push('      <div id="footMeta">—</div>');
	H.push('      <div>Code Audit Dashboard</div>');
	H.push('    </div>');
	H.push('  </div>');

	H.push('</div>');
	H.push('<script src="/app.js"></script>');
	H.push('</body>');
	H.push('</html>');
	return H.join("\n");
}

function appJs() {
	const J = [];
	J.push('"use strict";');

	J.push('const neon = { cyan:"#22d3ee", purple:"#a78bfa", green:"#34d399", pink:"#fb7185", yellow:"#facc15" };');
	J.push('const palette = ["#22d3ee","#a78bfa","#34d399","#fb7185","#facc15","#60a5fa","#f472b6","#2dd4bf","#c084fc","#f59e0b"];');

	J.push('let charts = { lang:null, dirs:null, projects:null, loc:null, cd:null };');

	J.push('let ui = {');
	J.push('  tab:"overview",');
	J.push('  reportId:"",');
	J.push('  projectsKey:"",');
	J.push('  report:null,');
	J.push('  explorer:{ project:"", dir:"", page:1, pageSize:250, sort:"code", order:"desc", q:"", lowComments:false, minified:false, dirty:true, nav:[] }');
	J.push('};');

	J.push('function fmt(n){ try{ return Number(n||0).toLocaleString("es-ES"); }catch{ return String(n||0); } }');
	J.push('function esc(s){ return String(s).replace(/[&<>"\\\']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","\\\'":"&#39;" }[c])); }');
	J.push('async function getJSON(p, opts){ const r = await fetch(p, opts); if(!r.ok) throw new Error("HTTP "+r.status); return await r.json(); }');
	J.push('function setStatus(t){ document.getElementById("status").textContent = t || ""; }');
	J.push('function sumObj(o){ let s=0; for(const k in (o||{})) s += (o[k]||0); return s; }');

	J.push('function showTab(name){');
	J.push('  ui.tab = name;');
	J.push('  document.getElementById("tabOverview").classList.toggle("active", name==="overview");');
	J.push('  document.getElementById("tabExplorer").classList.toggle("active", name==="explorer");');
	J.push('  document.getElementById("tabSnapshots").classList.toggle("active", name==="snapshots");');
	J.push('  document.getElementById("viewOverview").classList.toggle("hidden", name!=="overview");');
	J.push('  document.getElementById("viewExplorer").classList.toggle("hidden", name!=="explorer");');
	J.push('  document.getElementById("viewSnapshots").classList.toggle("hidden", name!=="snapshots");');
	J.push('}');

	J.push('function ensureChart(key, canvasId, type, labels, data, options){');
	J.push('  if(!charts[key]){');
	J.push('    charts[key] = new Chart(document.getElementById(canvasId), { type:type, data:{ labels:labels, datasets:data }, options:options });');
	J.push('    return;');
	J.push('  }');
	J.push('  charts[key].data.labels = labels;');
	J.push('  charts[key].data.datasets = data;');
	J.push('  charts[key].update("none");');
	J.push('}');

	J.push('function chartBaseOptions(isDonut){');
	J.push('  const opt = { responsive:true, maintainAspectRatio:false, animation:false,');
	J.push('    plugins:{ legend:{ labels:{ color:"rgba(255,255,255,.75)", font:{ family:"ui-monospace,Menlo,Consolas,monospace", size:11 } } },');
	J.push('              tooltip:{ enabled:true, callbacks:{ label:(ctx)=>{ const v=ctx.raw||0; const t=ctx.dataset.data.reduce((a,b)=>a+b,0)||1; const p=(v/t*100).toFixed(1); return " "+ctx.label+": "+v+" ("+p+"%)"; } } } }');
	J.push('  };');
	J.push('  if(!isDonut){');
	J.push('    opt.scales = {');
	J.push('      x:{ ticks:{ color:"rgba(255,255,255,.70)", font:{ family:"ui-monospace,Menlo,Consolas,monospace", size:11 } }, grid:{ color:"rgba(255,255,255,.06)" } },');
	J.push('      y:{ ticks:{ color:"rgba(255,255,255,.70)", font:{ family:"ui-monospace,Menlo,Consolas,monospace", size:11 } }, grid:{ color:"rgba(255,255,255,.06)" } }');
	J.push('    };');
	J.push('  } else { opt.cutout = "72%"; }');
	J.push('  return opt;');
	J.push('}');

	J.push('function renderOverview(r){');
	J.push('  const t=r.summary.totals; const ratios=r.summary.ratios||{commentDensity:0,blankRatio:0}; const c=r.summary.central||{};');
	J.push('  document.getElementById("mCode").textContent = fmt(t.code);');
	J.push('  document.getElementById("mTotal").textContent = fmt(t.physical);');
	J.push('  document.getElementById("mComments").textContent = fmt(t.comments);');
	J.push('  document.getElementById("mMin").textContent = fmt(r.summary.minifiedFiles);');
	J.push('  document.getElementById("mDup").textContent = fmt(r.summary.duplicateGroups);');
	J.push('  document.getElementById("mDupFiles").textContent = fmt(r.summary.duplicateFiles) + " files";');
	J.push('  document.getElementById("mCoverage").textContent = "Coverage: " + (ratios.commentDensity*100).toFixed(1) + "% · Debt: " + fmt(Object.values(r.debt||{}).reduce((a,b)=>a+(b||0),0));');
	J.push('  document.getElementById("mBlank").textContent = "Blank: " + (ratios.blankRatio*100).toFixed(1) + "%";');
	J.push('  document.getElementById("mMedian").textContent = "Median file code: " + Math.round(c.medianFileCode||0) + " · LOC: " + Math.round(c.medianFileLOC||0);');
	J.push('  document.getElementById("metaGen").textContent = r.generatedAt + " · " + Math.round((r.durationMs||0)/1000) + "s · analyzed " + fmt(r.summary.filesAnalyzed) + " · skipped " + fmt(r.summary.filesSkipped);');
	J.push('  document.getElementById("footMeta").textContent = "Generated " + r.generatedAt;');

	J.push('  const byLang=r.byLanguage||{};');
	J.push('  const labels=Object.keys(byLang);');
	J.push('  const values=labels.map(k=>byLang[k].code||0);');
	J.push('  const colors=labels.map((_,i)=>palette[i%palette.length]);');
	J.push('  ensureChart("lang","chartLang","doughnut",labels,[{ label:"Code", data:values, backgroundColor:colors, borderColor:"rgba(0,0,0,.55)", borderWidth:2, hoverOffset:10 }], Object.assign(chartBaseOptions(true), { plugins:{ legend:{ position:"right", labels:{ color:"rgba(255,255,255,.75)" } } } }));');

	J.push('  const topDirs=(r.topDirsByCode||[]).slice(0,10);');
	J.push('  const dLab=topDirs.map(d=>d.dir.length>28?("…"+d.dir.slice(-28)):d.dir);');
	J.push('  const dVal=topDirs.map(d=>d.code||0);');
	J.push('  ensureChart("dirs","chartDirs","bar",dLab,[{ label:"Code", data:dVal, backgroundColor:"rgba(34,211,238,.35)", borderColor:"rgba(34,211,238,.75)", borderWidth:1 }], chartBaseOptions(false));');

	J.push('  const byProj=r.byProject||{};');
	J.push('  const pLab=Object.keys(byProj);');
	J.push('  const pCode=pLab.map(p=>byProj[p].code||0);');
	J.push('  const pComm=pLab.map(p=>byProj[p].comments||0);');
	J.push('  ensureChart("projects","chartProjects","bar",pLab,[');
	J.push('    { label:"Code", data:pCode, backgroundColor:"rgba(167,139,250,.35)", borderColor:"rgba(167,139,250,.75)", borderWidth:1, stack:"s" },');
	J.push('    { label:"Comments", data:pComm, backgroundColor:"rgba(52,211,153,.30)", borderColor:"rgba(52,211,153,.70)", borderWidth:1, stack:"s" }');
	J.push('  ], Object.assign(chartBaseOptions(false), { plugins:{ legend:{ labels:{ color:"rgba(255,255,255,.75)" } } } }));');

	J.push('  const edges=r.distributions?.locEdges||[50,200,500,1000,2000];');
	J.push('  const loc=r.distributions?.locBuckets||[0,0,0,0,0,0];');
	J.push('  const locLabels=[ "0-"+edges[0], (edges[0]+1)+"-"+edges[1], (edges[1]+1)+"-"+edges[2], (edges[2]+1)+"-"+edges[3], (edges[3]+1)+"-"+edges[4], (edges[4]+1)+"+" ];');
	J.push('  ensureChart("loc","chartLOC","bar",locLabels,[{ label:"Files", data:loc.slice(0,6), backgroundColor:"rgba(251,113,133,.25)", borderColor:"rgba(251,113,133,.60)", borderWidth:1 }], chartBaseOptions(false));');

	J.push('  const cd=r.distributions?.commentDensityBuckets||[0,0,0,0,0,0];');
	J.push('  const cdLabels=["0%","0-2%","2-8%","8-15%","15-30%","30%+"];');
	J.push('  ensureChart("cd","chartCD","bar",cdLabels,[{ label:"Files", data:cd, backgroundColor:"rgba(250,204,21,.20)", borderColor:"rgba(250,204,21,.55)", borderWidth:1 }], chartBaseOptions(false));');

	J.push('  function fillList(elId, items, mode){');
	J.push('    const el=document.getElementById(elId);');
	J.push('    if(!items || !items.length){ el.innerHTML = "<div style=\\"color:rgba(255,255,255,.55);font-family:var(--mono);font-size:12px;\\">—</div>"; return; }');
	J.push('    el.innerHTML = items.map(it=>{');
	J.push('      const name = esc(it.project + "/" + it.path);');
	J.push('      const num = (mode==="code") ? it.code : (mode==="debt") ? it.debt : it.risk;');
	J.push('      return "<div class=\\"item\\"><div class=\\"name\\">"+name+"</div><div class=\\"num\\">"+num+"</div></div>";');
	J.push('    }).join("");');
	J.push('  }');
	J.push('  fillList("listTopFiles", r.topFilesByCode||[], "code");');
	J.push('  fillList("listDebt", r.debtTopFiles||[], "debt");');
	J.push('  fillList("listRisk", r.riskTopFiles||[], "risk");');
	J.push('}');

	J.push('function setExplorerProjectIfNeeded(r){');
	J.push('  const sel = ui.explorer;');
	J.push('  const projects = Object.keys(r.byProject||{});');
	J.push('  const key = projects.join("|");');
	J.push('  if(key !== ui.projectsKey){');
	J.push('    ui.projectsKey = key;');
	J.push('    const p = projects[0] || "";');
	J.push('    sel.project = sel.project || p;');
	J.push('    sel.dir = "";');
	J.push('    sel.page = 1;');
	J.push('    sel.nav = [];');
	J.push('    sel.dirty = true;');
	J.push('  }');
	J.push('}');

	J.push('function explorerCrumb(){');
	J.push('  const e=ui.explorer;');
	J.push('  return e.project + (e.dir ? ("/"+e.dir) : "");');
	J.push('}');

	J.push('function renderTree(tree){');
	J.push('  const el=document.getElementById("tree");');
	J.push('  if(!tree || !tree.dirs || !tree.dirs.length){ el.innerHTML = "<div style=\\"color:rgba(255,255,255,.55);font-family:var(--mono);font-size:12px;\\">No subfolders</div>"; return; }');
	J.push('  el.innerHTML = tree.dirs.slice(0,300).map(d=>{');
	J.push('    const label = esc(d.dir.split("/").pop());');
	J.push('    const meta = "code " + fmt(d.code);');
	J.push('    return "<div class=\\"node\\" data-dir=\\""+esc(d.dir)+"\\"><div class=\\"label\\">"+label+"</div><div class=\\"meta\\">"+meta+"</div></div>";');
	J.push('  }).join("");');
	J.push('  el.querySelectorAll(".node").forEach(n=>{');
	J.push('    n.addEventListener("click", ()=>{');
	J.push('      const dir = n.getAttribute("data-dir");');
	J.push('      navPush(dir);');
	J.push('    });');
	J.push('  });');
	J.push('}');

	J.push('function updateSortArrows(){');
	J.push('  const e=ui.explorer;');
	J.push('  document.querySelectorAll("#viewExplorer thead th").forEach(th=>{');
	J.push('    const k=th.getAttribute("data-sort");');
	J.push('    const base = th.textContent.replace(/\\s*[▲▼]\\s*$/,"");');
	J.push('    th.textContent = base;');
	J.push('    if(k === e.sort){ th.textContent = base + " " + (e.order==="asc" ? "▲" : "▼"); }');
	J.push('  });');
	J.push('}');

	J.push('function renderTable(files){');
	J.push('  const tb=document.getElementById("tbl");');
	J.push('  if(!files || !files.items){ tb.innerHTML = ""; return; }');
	J.push('  tb.innerHTML = files.items.map(f=>{');
	J.push('    const cov = (f.stats?.code||0) ? ((f.stats.comments||0)/(f.stats.code||1)) : 0;');
	J.push('    const debt = sumObj(f.debt);');
	J.push('    const risk = sumObj(f.risk);');
	J.push('    const badges = (f.minified ? "<span class=\\"badge min\\">MIN</span>" : "") + (f.skipped ? "<span class=\\"badge skip\\">SKIP</span>" : "");');
	J.push('    return "<tr class=\\"file\\" data-project=\\""+esc(f.project)+"\\" data-path=\\""+esc(f.path)+"\\">"');
	J.push('      + "<td>"+esc(f.path)+badges+"</td>"');
	J.push('      + "<td class=\\"num\\">"+fmt(f.stats?.code||0)+"</td>"');
	J.push('      + "<td class=\\"num\\">"+fmt(f.stats?.comments||0)+"</td>"');
	J.push('      + "<td class=\\"num\\">"+fmt(f.stats?.physical||0)+"</td>"');
	J.push('      + "<td class=\\"num\\">"+(cov*100).toFixed(1)+"%</td>"');
	J.push('      + "<td class=\\"num\\">"+fmt(debt)+"</td>"');
	J.push('      + "<td class=\\"num\\">"+fmt(risk)+"</td>"');
	J.push('      + "<td class=\\"num\\">"+fmt(f.sizeBytes||0)+"</td>"');
	J.push('      + "</tr>";');
	J.push('  }).join("");');
	J.push('}');

	J.push('async function refreshExplorer(){');
	J.push('  if(ui.tab !== "explorer") return;');
	J.push('  const e=ui.explorer;');
	J.push('  if(!e.project) return;');
	J.push('  if(!e.dirty) return;');
	J.push('  document.getElementById("crumb").textContent = explorerCrumb();');
	J.push('  const tree = await getJSON("/api/tree?project="+encodeURIComponent(e.project)+"&dir="+encodeURIComponent(e.dir));');
	J.push('  renderTree(tree);');
	J.push('  const qs = new URLSearchParams({');
	J.push('    project:e.project, dir:e.dir, q:e.q||"", page:String(e.page), pageSize:String(e.pageSize), sort:e.sort, order:e.order,');
	J.push('    lowComments: e.lowComments ? "1":"0", minified: e.minified ? "1":"0"');
	J.push('  }).toString();');
	J.push('  const files = await getJSON("/api/files?"+qs);');
	J.push('  renderTable(files);');
	J.push('  document.getElementById("pager").textContent = "Page " + files.page + " · " + fmt(files.pageSize) + " per page · total " + fmt(files.total);');
	J.push('  document.getElementById("explMeta").textContent = "Project " + e.project + " · dir " + (e.dir||"(root)") + " · sort " + e.sort + " " + e.order;');
	J.push('  document.getElementById("prev").disabled = files.page <= 1;');
	J.push('  document.getElementById("next").disabled = (files.page * files.pageSize) >= files.total;');
	J.push('  updateSortArrows();');
	J.push('  e.dirty = false;');
	J.push('}');

	J.push('function navPush(dir){');
	J.push('  const e=ui.explorer;');
	J.push('  if(e.dir) e.nav.push(e.dir);');
	J.push('  e.dir = dir;');
	J.push('  e.page = 1;');
	J.push('  e.dirty = true;');
	J.push('  refreshExplorer();');
	J.push('}');
	J.push('function navBack(){');
	J.push('  const e=ui.explorer;');
	J.push('  if(!e.nav.length) return;');
	J.push('  e.dir = e.nav.pop();');
	J.push('  e.page = 1;');
	J.push('  e.dirty = true;');
	J.push('  refreshExplorer();');
	J.push('}');
	J.push('function navUp(){');
	J.push('  const e=ui.explorer;');
	J.push('  if(!e.dir) return;');
	J.push('  const parts = e.dir.split("/");');
	J.push('  parts.pop();');
	J.push('  const up = parts.join("/");');
	J.push('  if(e.dir) e.nav.push(e.dir);');
	J.push('  e.dir = up;');
	J.push('  e.page = 1;');
	J.push('  e.dirty = true;');
	J.push('  refreshExplorer();');
	J.push('}');

	J.push('function drawerOpen(payload){');
	J.push('  const wrap=document.getElementById("drawerWrap"); wrap.classList.add("on");');
	J.push('  const f=payload.file;');
	J.push('  document.getElementById("dPath").textContent = f.project + "/" + f.path;');
	J.push('  const code=f.stats?.code||0, comm=f.stats?.comments||0, tot=f.stats?.physical||0;');
	J.push('  const cov = code ? (comm / code) : 0;');
	J.push('  document.getElementById("dCode").textContent = fmt(code);');
	J.push('  document.getElementById("dComm").textContent = fmt(comm);');
	J.push('  document.getElementById("dTotal").textContent = fmt(tot);');
	J.push('  document.getElementById("dCov").textContent = (cov*100).toFixed(1) + "%";');
	J.push('  document.getElementById("dDebt").textContent = JSON.stringify(f.debt||{}, null, 2);');
	J.push('  document.getElementById("dRisk").textContent = JSON.stringify(f.risk||{}, null, 2);');
	J.push('  const dups=payload.duplicates||[];');
	J.push('  document.getElementById("dDup").textContent = dups.length ? dups.map(x => x.project + "/" + x.path + " (" + x.sizeBytes + "b)").join("\\n") : "No duplicates detected";');
	J.push('}');
	J.push('function drawerClose(){ document.getElementById("drawerWrap").classList.remove("on"); }');

	J.push('async function openInspectorFromRow(tr){');
	J.push('  const project = tr.getAttribute("data-project");');
	J.push('  const pth = tr.getAttribute("data-path");');
	J.push('  const payload = await getJSON("/api/file?project="+encodeURIComponent(project)+"&path="+encodeURIComponent(pth));');
	J.push('  if(payload && !payload.error) drawerOpen(payload);');
	J.push('}');

	J.push('async function refreshSnapshots(){');
	J.push('  if(ui.tab !== "snapshots") return;');
	J.push('  const snaps = await getJSON("/api/snapshots");');
	J.push('  const selA=document.getElementById("selA");');
	J.push('  const selB=document.getElementById("selB");');
	J.push('  const opts = snaps.map(s => "<option value=\\"" + esc(s.id) + "\\">" + esc(s.id) + " · " + fmt(s.sizeBytes) + "b</option>").join("");');
	J.push('  selA.innerHTML = opts; selB.innerHTML = opts;');
	J.push('  if(snaps[1]){ selA.value = snaps[1].id; selB.value = snaps[0].id; }');
	J.push('}');

	J.push('async function doDiff(){');
	J.push('  const a=document.getElementById("selA").value;');
	J.push('  const b=document.getElementById("selB").value;');
	J.push('  if(!a || !b) return;');
	J.push('  const d = await getJSON("/api/diff?from="+encodeURIComponent(a)+"&to="+encodeURIComponent(b));');
	J.push('  document.getElementById("diffBox").textContent = JSON.stringify(d, null, 2);');
	J.push('}');

	J.push('async function poll(){');
	J.push('  try{');
	J.push('    const data = await getJSON("/api/metrics");');
	J.push('    if(data.scanning){');
	J.push('      const p = data.progress && data.progress.total ? (data.progress.done||0) + "/" + data.progress.total : "";');
	J.push('      setStatus("SCANNING " + p);');
	J.push('    } else { setStatus(data.last ? "READY" : "NO DATA"); }');
	J.push('    if(!data.last) return;');
	J.push('    const r = data.last;');
	J.push('    const id = r.generatedAt || "";');
	J.push('    const changed = id && id !== ui.reportId;');
	J.push('    ui.report = r;');
	J.push('    if(changed){');
	J.push('      ui.reportId = id;');
	J.push('      renderOverview(r);');
	J.push('      setExplorerProjectIfNeeded(r);');
	J.push('      if(ui.tab === "explorer"){ ui.explorer.dirty = true; refreshExplorer(); }');
	J.push('      if(ui.tab === "snapshots"){ refreshSnapshots(); }');
	J.push('    }');
	J.push('  } catch {}');
	J.push('}');

	J.push('async function triggerScan(){ await fetch("/api/scan",{method:"POST"}); }');
	J.push('async function triggerSnapshot(){ await fetch("/api/snapshot",{method:"POST"}); }');

	J.push('async function loadAll(){');
	J.push('  const e=ui.explorer;');
	J.push('  const qs = new URLSearchParams({ project:e.project, dir:e.dir, q:e.q||"", sort:e.sort, order:e.order, lowComments:e.lowComments?"1":"0", minified:e.minified?"1":"0", all:"1", cap:"20000" }).toString();');
	J.push('  const files = await getJSON("/api/files?"+qs);');
	J.push('  renderTable(files);');
	J.push('  document.getElementById("pager").textContent = files.capped ? ("Loaded cap " + fmt(files.pageSize) + " (total " + fmt(files.total) + ")") : ("Loaded all " + fmt(files.total));');
	J.push('  updateSortArrows();');
	J.push('}');

	J.push('function presetExplorer(mode){');
	J.push('  showTab("explorer");');
	J.push('  const e=ui.explorer;');
	J.push('  e.page=1; e.q=""; e.minified=false; e.lowComments=false;');
	J.push('  if(mode==="largest"){ e.sort="lines"; e.order="desc"; }');
	J.push('  if(mode==="debt"){ e.sort="debt"; e.order="desc"; }');
	J.push('  if(mode==="risk"){ e.sort="risk"; e.order="desc"; }');
	J.push('  e.dirty=true; refreshExplorer();');
	J.push('}');

	J.push('function bind(){');
	J.push('  document.getElementById("tabOverview").addEventListener("click", ()=>showTab("overview"));');
	J.push('  document.getElementById("tabExplorer").addEventListener("click", ()=>{ showTab("explorer"); ui.explorer.dirty=true; refreshExplorer(); });');
	J.push('  document.getElementById("tabSnapshots").addEventListener("click", ()=>{ showTab("snapshots"); refreshSnapshots(); });');

	J.push('  document.getElementById("btnScan").addEventListener("click", triggerScan);');
	J.push('  document.getElementById("btnSnapshot").addEventListener("click", triggerSnapshot);');

	J.push('  document.getElementById("qaLargest").addEventListener("click", ()=>presetExplorer("largest"));');
	J.push('  document.getElementById("qaDebt").addEventListener("click", ()=>presetExplorer("debt"));');
	J.push('  document.getElementById("qaRisk").addEventListener("click", ()=>presetExplorer("risk"));');

	J.push('  document.getElementById("btnBack").addEventListener("click", navBack);');
	J.push('  document.getElementById("btnUp").addEventListener("click", navUp);');

	J.push('  document.getElementById("inpSearch").addEventListener("input", (e)=>{ ui.explorer.q=e.target.value||""; ui.explorer.page=1; ui.explorer.dirty=true; refreshExplorer(); });');
	J.push('  document.getElementById("chkLowComments").addEventListener("change",(e)=>{ ui.explorer.lowComments=!!e.target.checked; ui.explorer.page=1; ui.explorer.dirty=true; refreshExplorer(); });');
	J.push('  document.getElementById("chkMinified").addEventListener("change",(e)=>{ ui.explorer.minified=!!e.target.checked; ui.explorer.page=1; ui.explorer.dirty=true; refreshExplorer(); });');

	J.push('  document.getElementById("btnLoadAll").addEventListener("click", loadAll);');
	J.push('  document.getElementById("prev").addEventListener("click", ()=>{ if(ui.explorer.page>1){ ui.explorer.page--; ui.explorer.dirty=true; refreshExplorer(); } });');
	J.push('  document.getElementById("next").addEventListener("click", ()=>{ ui.explorer.page++; ui.explorer.dirty=true; refreshExplorer(); });');

	J.push('  document.querySelectorAll("#viewExplorer thead th").forEach(th=>{');
	J.push('    th.addEventListener("click", ()=>{');
	J.push('      const k=th.getAttribute("data-sort");');
	J.push('      if(!k) return;');
	J.push('      if(ui.explorer.sort === k){ ui.explorer.order = (ui.explorer.order==="asc") ? "desc" : "asc"; }');
	J.push('      else { ui.explorer.sort = k; ui.explorer.order = "desc"; }');
	J.push('      ui.explorer.page=1; ui.explorer.dirty=true; refreshExplorer();');
	J.push('    });');
	J.push('  });');

	J.push('  document.getElementById("tbl").addEventListener("click", async (e)=>{');
	J.push('    const tr = e.target.closest("tr.file");');
	J.push('    if(!tr) return;');
	J.push('    await openInspectorFromRow(tr);');
	J.push('  });');

	J.push('  document.getElementById("drawerClose").addEventListener("click", drawerClose);');
	J.push('  document.getElementById("drawerBg").addEventListener("click", drawerClose);');

	J.push('  document.getElementById("btnRefreshSnaps").addEventListener("click", refreshSnapshots);');
	J.push('  document.getElementById("btnDiff").addEventListener("click", doDiff);');
	J.push('}');

	J.push('bind();');
	J.push('setInterval(poll, 1200); poll();');

	return J.join("\n");
}

// ------------ HTTP server ------------
const cfg = parseArgs(process.argv);

let scanning = false;
let lastResult = null;
let progress = null;

async function startScan() {
	if (scanning) return;
	scanning = true;
	progress = { phase: "init", done: 0, total: 0 };

	try {
		const res = await scanAll(cfg, (p) => { progress = { ...progress, ...p }; });
		lastResult = res;
	} catch (e) {
		lastResult = {
			generatedAt: nowISO(),
			durationMs: 0,
			error: String(e?.stack || e?.message || e),
			version: VERSION,
			summary: { totals: makeStats(), filesAnalyzed: 0, filesSkipped: 0, totalSizeBytes: 0, minifiedFiles: 0, duplicateGroups: 0, duplicateFiles: 0, ratios: { commentDensity: 0, blankRatio: 0 }, central: { avgFileLOC:0, medianFileLOC:0, avgFileCode:0, medianFileCode:0 } },
			byLanguage: {}, byDir: {}, byProject: {}, topDirsByCode: [], topFilesByCode: [],
			debtTopFiles: [], riskTopFiles: [],
			files: [],
			debt: { TODO: 0, FIXME: 0, HACK: 0, XXX: 0, BUG: 0, NOTE: 0, JSDOC: 0 },
			riskTotals: { eval: 0, newFunction: 0, child_process: 0, exec: 0, rmrf: 0, sqlRaw: 0 },
			duplicates: [],
			distributions: { locEdges:[50,200,500,1000,2000], locBuckets:[0,0,0,0,0,0], commentDensityBuckets:[0,0,0,0,0,0] }
		};
	} finally {
		scanning = false;
		progress = null;
	}
}

function send(res, code, body, headers = {}) {
	res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
	res.end(body);
}
function sendHTML(res, html) {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(html);
}
function sendJS(res, js) {
	res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
	res.end(js);
}
function sendJSON(res, obj) {
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
	const parsed = url.parse(req.url, true);
	const pathname = parsed.pathname || "/";

	if (req.method === "GET" && pathname === "/") return sendHTML(res, htmlPage());
	if (req.method === "GET" && pathname === "/app.js") return sendJS(res, appJs());
	if (req.method === "GET" && pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }

	if (req.method === "GET" && pathname === "/api/metrics") {
		return sendJSON(res, { scanning: scanning, progress: progress, last: lastResult });
	}

	if (req.method === "POST" && pathname === "/api/scan") {
		startScan();
		return send(res, 200, "OK");
	}

	if (req.method === "GET" && pathname === "/api/report") {
		return sendJSON(res, lastResult || { scanning: scanning, progress: progress, last: null });
	}

	if (req.method === "GET" && pathname === "/api/files") {
		if (!lastResult) return sendJSON(res, { page: 1, pageSize: 0, total: 0, items: [] });
		return sendJSON(res, filterAndPageFiles(lastResult, parsed.query || {}));
	}

	if (req.method === "GET" && pathname === "/api/tree") {
		if (!lastResult) return sendJSON(res, { project: "", dir: "", files: { count: 0, stats: makeStats() }, dirs: [] });
		const project = String(parsed.query.project || "");
		if (!project) return sendJSON(res, { project: "", dir: "", files: { count: 0, stats: makeStats() }, dirs: [] });
		const dir = String(parsed.query.dir || "");
		return sendJSON(res, getDirChildren(lastResult, project, dir));
	}

	if (req.method === "GET" && pathname === "/api/file") {
		if (!lastResult) return sendJSON(res, { error: "No report" });
		const project = String(parsed.query.project || "");
		const filePath = String(parsed.query.path || "");
		if (!project || !filePath) return sendJSON(res, { error: "Missing project/path" });

		const file = (lastResult.files || []).find(f => f.project === project && f.path === filePath);
		if (!file) return sendJSON(res, { error: "Not found" });

		let duplicates = [];
		if (file.hash) {
			const group = (lastResult.duplicates || []).find(g => g.hash === file.hash);
			if (group) duplicates = group.files || [];
		}
		return sendJSON(res, { file: file, duplicates: duplicates });
	}

	if (req.method === "GET" && pathname === "/api/snapshots") {
		const snaps = await listSnapshots(cfg);
		return sendJSON(res, snaps);
	}

	if (req.method === "POST" && pathname === "/api/snapshot") {
		if (!lastResult) return send(res, 400, "No report to snapshot");
		const snap = await saveSnapshot(cfg, lastResult);
		return sendJSON(res, snap);
	}

	if (req.method === "GET" && pathname === "/api/diff") {
		const from = String(parsed.query.from || "");
		const to = String(parsed.query.to || "");
		if (!from || !to) return send(res, 400, "Missing from/to");
		try {
			const A = await readSnapshot(cfg, from);
			const B = await readSnapshot(cfg, to);
			return sendJSON(res, diffReports(A, B));
		} catch (e) {
			return send(res, 500, "Diff error: " + String(e?.message || e));
		}
	}

	if (req.method === "GET" && pathname === "/api/export.csv") {
		if (!lastResult) return send(res, 400, "No report");
		const scope = String(parsed.query.scope || "files");
		let csv = "";

		if (scope === "languages") {
			const rows = Object.entries(lastResult.byLanguage || {}).map(([k, v]) => ({
				language: k, code: v.code, comments: v.comments, physical: v.physical, blank: v.blank
			})).sort((a, b) => b.code - a.code);
			csv = toCSV(rows, ["language", "code", "comments", "physical", "blank"]);
		} else if (scope === "projects") {
			const rows = Object.entries(lastResult.byProject || {}).map(([k, v]) => ({
				project: k, code: v.code, comments: v.comments, physical: v.physical, blank: v.blank
			})).sort((a, b) => b.code - a.code);
			csv = toCSV(rows, ["project", "code", "comments", "physical", "blank"]);
		} else if (scope === "dirs") {
			const rows = Object.entries(lastResult.byDir || {}).map(([k, v]) => ({
				dir: k, code: v.code, comments: v.comments, physical: v.physical, blank: v.blank
			})).sort((a, b) => b.code - a.code);
			csv = toCSV(rows, ["dir", "code", "comments", "physical", "blank"]);
		} else {
			const rows = (lastResult.files || []).map(f => ({
				project: f.project, path: f.path, dir: f.dir || "", ext: f.ext, language: f.language,
				sizeBytes: f.sizeBytes, skipped: f.skipped ? 1 : 0, minified: f.minified ? 1 : 0,
				code: f.stats?.code || 0, comments: f.stats?.comments || 0, physical: f.stats?.physical || 0
			})).sort((a, b) => b.code - a.code);
			csv = toCSV(rows, ["project","path","dir","ext","language","sizeBytes","skipped","minified","code","comments","physical"]);
		}

		res.writeHead(200, {
			"Content-Type": "text/csv; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Disposition": 'attachment; filename="audit_' + scope + '.csv"',
		});
		return res.end(csv);
	}

	return send(res, 404, "Not Found");
});

server.on("clientError", (err, socket) => {
	try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
});

async function listenWithAutoPort(server, port, tries, enabled) {
	return new Promise((resolve, reject) => {
		let p = port;
		let remaining = tries;

		const tryListen = () => {
			server.once("error", (err) => {
				if (enabled && err && err.code === "EADDRINUSE" && remaining > 0) {
					p++;
					remaining--;
					tryListen();
				} else reject(err);
			});

			server.listen(p, () => resolve(p));
		};

		tryListen();
	});
}

// initial scan
startScan().catch(() => {});

(async () => {
	try {
		const boundPort = await listenWithAutoPort(server, cfg.port, cfg.autoPortMaxTries, cfg.autoPort);
		console.log("\n🚀 Code Audit Dashboard running");
		console.log("🌐 http://localhost:" + boundPort);
		console.log("📌 roots:");
		for (const r of cfg.roots) console.log("   - " + r);
		console.log("⚙️  concurrency=" + cfg.concurrency + "  maxBytes=" + cfg.maxBytes + "  port=" + boundPort);
		console.log("© Nubaro\n");
	} catch (e) {
		console.error("Failed to start:", e?.message || e);
		process.exit(1);
	}
})();
