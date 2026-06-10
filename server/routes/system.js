/**
 * SYSTEM STATS API ROUTES
 * =======================
 *
 * Lightweight host hardware telemetry for the sidebar footer widget:
 *
 *   GET /api/system/stats →
 *     {
 *       cpu:    { percent: number },                            // 0..100, 1 decimal
 *       memory: { usedBytes, totalBytes, percent }              // percent 0..100, 1 decimal
 *     }
 *
 * CPU measurement — /proc/stat delta (chosen over os.loadavg):
 *   loadavg is a 1-minute exponential average of the run-queue length and
 *   lags badly behind actual utilisation; /proc/stat jiffy counters diffed
 *   over a real time window give the true busy ratio. We keep the previous
 *   aggregate sample in module state, so each request after the first is a
 *   single cheap read (delta vs. the last sample). The very first request
 *   takes a 250 ms two-point sample for an immediately accurate value.
 *   Samples closer together than MIN_SAMPLE_MS reuse the last computed
 *   percent to avoid noisy micro-deltas. On non-Linux hosts (no /proc) we
 *   fall back to loadavg normalised by core count.
 *
 * Memory — /proc/meminfo MemAvailable (kernel's own estimate of reclaimable
 *   memory, includes cache/buffers) rather than os.freemem(), which reports
 *   strictly-free pages and wildly overstates usage on a Linux box with a
 *   warm page cache. Fallback: os.totalmem()/os.freemem().
 *
 * No new dependencies; node:fs + node:os only.
 */

import { promises as fsPromises } from 'fs';
import os from 'os';

import express from 'express';

const router = express.Router();

// Two CPU samples closer than this reuse the previously computed percent.
const MIN_SAMPLE_MS = 500;
// Two-point sampling window used only for the very first request.
const FIRST_SAMPLE_MS = 250;

// Module-level previous sample: { idle, total, at, percent }
let lastCpuSample = null;

/**
 * Parse the aggregate "cpu " line of /proc/stat into jiffy counters.
 * Returns { idle, total } where idle includes iowait.
 */
export function parseCpuLine(procStatText) {
    const line = procStatText.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) {
        return null;
    }
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 4 || fields.some(Number.isNaN)) {
        return null;
    }
    // user nice system idle iowait irq softirq steal [guest guest_nice]
    const idle = fields[3] + (fields[4] || 0);
    const total = fields.reduce((sum, v) => sum + v, 0);
    return { idle, total };
}

/**
 * Parse /proc/meminfo for MemTotal / MemAvailable (values are in kB).
 * Returns { totalBytes, availableBytes } or null when fields are missing.
 */
export function parseMeminfo(meminfoText) {
    const grab = (key) => {
        const match = meminfoText.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
        return match ? Number(match[1]) * 1024 : null;
    };
    const totalBytes = grab('MemTotal');
    const availableBytes = grab('MemAvailable');
    if (totalBytes === null || availableBytes === null) {
        return null;
    }
    return { totalBytes, availableBytes };
}

/** Busy percent from two jiffy samples; clamped to [0, 100]. */
export function cpuPercentFromSamples(prev, cur) {
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    if (dTotal <= 0) {
        return null;
    }
    const percent = ((dTotal - dIdle) / dTotal) * 100;
    return Math.min(100, Math.max(0, percent));
}

const round1 = (n) => Math.round(n * 10) / 10;

async function readCpuSample() {
    const text = await fsPromises.readFile('/proc/stat', 'utf8');
    return parseCpuLine(text);
}

async function getCpuPercent() {
    try {
        const now = Date.now();
        const cur = await readCpuSample();
        if (!cur) {
            throw new Error('unparseable /proc/stat');
        }

        if (!lastCpuSample) {
            // First request: take a short two-point sample for an accurate value.
            await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_MS));
            const next = await readCpuSample();
            const percent = (next && cpuPercentFromSamples(cur, next)) ?? 0;
            lastCpuSample = { ...(next || cur), at: Date.now(), percent };
            return percent;
        }

        if (now - lastCpuSample.at < MIN_SAMPLE_MS) {
            return lastCpuSample.percent;
        }

        const percent = cpuPercentFromSamples(lastCpuSample, cur) ?? lastCpuSample.percent;
        lastCpuSample = { ...cur, at: now, percent };
        return percent;
    } catch {
        // Non-Linux fallback: 1-minute loadavg normalised by core count.
        const cores = os.cpus().length || 1;
        return Math.min(100, Math.max(0, (os.loadavg()[0] / cores) * 100));
    }
}

async function getMemoryStats() {
    try {
        const text = await fsPromises.readFile('/proc/meminfo', 'utf8');
        const parsed = parseMeminfo(text);
        if (parsed) {
            const usedBytes = parsed.totalBytes - parsed.availableBytes;
            return {
                usedBytes,
                totalBytes: parsed.totalBytes,
                percent: round1((usedBytes / parsed.totalBytes) * 100),
            };
        }
    } catch {
        // fall through to the os fallback
    }
    const totalBytes = os.totalmem();
    const usedBytes = totalBytes - os.freemem();
    return {
        usedBytes,
        totalBytes,
        percent: round1((usedBytes / totalBytes) * 100),
    };
}

// GET /api/system/stats — live CPU + memory utilisation of the host.
router.get('/stats', async (req, res) => {
    try {
        const [cpuPercent, memory] = await Promise.all([getCpuPercent(), getMemoryStats()]);
        res.json({
            cpu: { percent: round1(cpuPercent) },
            memory,
        });
    } catch (error) {
        console.error('[system] stats failed:', error.message);
        res.status(500).json({ error: 'Failed to read system stats' });
    }
});

export default router;
