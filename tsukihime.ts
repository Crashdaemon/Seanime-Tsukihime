/// <reference path="./core.d.ts" />
/// <reference path="./anime-torrent-provider.d.ts" />

const DEFAULT_API = "https://api.tsukihime.org/v1"
const PAGE_SIZE = 100
const ENRICH_CONCURRENCY = 8
const DEFAULT_MAX_RESULTS = 50
const DEFAULT_SEARCH_DEPTH = 100
const MAX_SEARCH_DEPTH = 1000
const SEEDER_SANITY_CAP = 30000

interface TsukihimeGroup {
    id: number
    name: string
    is_fansub: number
}

interface TsukihimeTracker {
    url: string
    seeders: number
    leechers: number
    complete: number
}

interface TsukihimeFile {
    id: number
    filename: string
    size: number
}

interface TsukihimeTorrent {
    id: number
    state: string
    main_source: number
    nyaa_id: number
    sukebei_id: number
    nekobt_id: number
    tt_id: number
    name: string
    btih: string
    is_adult: number
    totalsize: number
    filecount: number
    audiolangs: string[]
    sublangs: string[]
    episode_no: number | null
    source_date: number
    added_date: number
    group?: TsukihimeGroup
    trackers?: TsukihimeTracker[]
    files?: TsukihimeFile[]
}

interface TsukihimeListResponse {
    total: number
    start: number
    limit: number
    error: boolean | string
    results: TsukihimeTorrent[]
}

interface TsukihimeAnime {
    id: number
    title: string
    english_title: string
    anilist: number
    mal: number
    anidb: number
}

function enc(s: string): string {
    return encodeURIComponent(s)
}

function stripTrailingSlash(s: string): string {
    while (s.length > 0 && s.charAt(s.length - 1) === "/") {
        s = s.substring(0, s.length - 1)
    }
    return s
}

function hasKey(obj: any, key: string | number): boolean {
    return Object.prototype.hasOwnProperty.call(obj, String(key))
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    let n = parseInt(raw || "", 10)
    if (isNaN(n)) n = fallback
    if (max >= 0 && min > max) min = max
    if (n < min) n = min
    if (max >= 0 && n > max) n = max
    return n
}

function errMsg(e: any): string {
    if (e && e.message) return String(e.message)
    return String(e)
}

function normalizeResolution(s: string): string {
    if (!s) return ""
    const v = s.toLowerCase()
    if (v.indexOf("4k") !== -1 || v.indexOf("2160") !== -1) return "2160"
    if (v.indexOf("1440") !== -1) return "1440"
    if (v.indexOf("1080") !== -1) return "1080"
    if (v.indexOf("720") !== -1) return "720"
    if (v.indexOf("540") !== -1) return "540"
    if (v.indexOf("480") !== -1) return "480"
    if (v.indexOf("360") !== -1) return "360"
    return v.replace(/p$/, "")
}

function parseResolutionFromName(name: string): string {
    const m =
        name.match(/(\d{3,4})\s*[pP]\b/) ||
        name.match(/\d{3,4}\s*[xX×]\s*(2160|1440|1080|720|540|480|360)\b/) ||
        name.match(/\b(2160|1440|1080|720|540|480|360)\b/)
    if (m) return m[1]
    if (name.toLowerCase().indexOf("4k") !== -1) return "2160"
    return ""
}

function resolutionMatches(name: string, wanted: string): boolean {
    const w = normalizeResolution(wanted)
    if (!w) return true
    return parseResolutionFromName(name) === w
}

const BATCH_RE = /\b(?:batch|complete|seasons?|s\d{1,2}\b(?![eE]\d)|\d{1,3}\s*[-~]\s*\d{1,3}|vol(?:ume)?|bd\s?box)\b/i

function detectBatch(name: string): boolean {
    return BATCH_RE.test(name)
}

function isBatchTorrent(t: TsukihimeTorrent): boolean {
    return detectBatch(t.name)
}

function parseEpisodeRange(name: string): { lo: number; hi: number } | null {
    const m = name.match(/(?:^|[^0-9])(\d{1,3})\s*[-~]\s*(\d{1,3})(?![0-9])/)
    if (!m) return null
    const lo = parseInt(m[1], 10)
    const hi = parseInt(m[2], 10)
    if (hi > lo && hi - lo < 200) return { lo: lo, hi: hi }
    return null
}

function batchContainsEpisode(name: string, ep: number): boolean {
    const r = parseEpisodeRange(name)
    if (r) return ep >= r.lo && ep <= r.hi
    return true
}

function parseEpisodeFromName(name: string): number {
    if (detectBatch(name)) return -1
    let m = name.match(/\b[sS]\d{1,2}[eE](\d{1,3})\b/)
    if (m) return parseInt(m[1], 10)
    m = name.match(/(?:^|[^0-9A-Za-z])[eE][pP]?\s?(\d{1,3})(?![0-9A-Za-z])/)
    if (m) return parseInt(m[1], 10)
    m = name.match(/(?:^|[\s_])[-#]\s?(\d{1,3})(?:v\d)?(?=[\s_.\[\(]|$)/)
    if (m) return parseInt(m[1], 10)
    return -1
}

function episodeOf(t: TsukihimeTorrent): number {
    const e = parseEpisodeFromName(t.name)
    if (e !== -1) return e
    if (!detectBatch(t.name) && t.episode_no != null) return t.episode_no
    return -1
}

function unixToRfc3339(source: number, added: number): string {
    const secRaw = Number(source) || Number(added) || 0
    const sec = isFinite(secRaw) && Math.abs(secRaw) <= 8.64e12 ? secRaw : 0
    return new Date(sec * 1000).toISOString()
}

function maxSeeders(trackers: TsukihimeTracker[] | undefined): { seeders: number; leechers: number } {
    let s = 0
    let l = 0
    if (trackers && trackers.length) {
        for (let i = 0; i < trackers.length; i++) {
            const tr = trackers[i]
            let ts = tr && typeof tr.seeders === "number" ? tr.seeders : 0
            let tl = tr && typeof tr.leechers === "number" ? tr.leechers : 0
            if (ts < 0 || ts > SEEDER_SANITY_CAP) ts = 0
            if (tl < 0 || tl > SEEDER_SANITY_CAP) tl = 0
            if (ts > s) s = ts
            if (tl > l) l = tl
        }
    }
    return { seeders: s, leechers: l }
}

function trackerUrlsOf(trackers: TsukihimeTracker[] | undefined): string[] {
    const out: string[] = []
    if (trackers && trackers.length) {
        for (let i = 0; i < trackers.length; i++) {
            const u = trackers[i] && trackers[i].url
            if (u) out.push(u)
        }
    }
    return out
}

function isAdultTorrent(t: TsukihimeTorrent): boolean {
    return t.is_adult === 1 || (typeof t.sukebei_id === "number" && t.sukebei_id > 0)
}

function sourceLink(t: TsukihimeTorrent): string {
    if (t.nyaa_id && t.nyaa_id > 0) return "https://nyaa.si/view/" + t.nyaa_id
    if (t.sukebei_id && t.sukebei_id > 0) return "https://sukebei.nyaa.si/view/" + t.sukebei_id
    return "https://tsukihime.org"
}

function sourceDownloadUrl(t: TsukihimeTorrent): string {
    if (t.nyaa_id && t.nyaa_id > 0) return "https://nyaa.si/download/" + t.nyaa_id + ".torrent"
    if (t.sukebei_id && t.sukebei_id > 0) return "https://sukebei.nyaa.si/download/" + t.sukebei_id + ".torrent"
    return ""
}

function buildMagnet(btih: string, name: string, trackerUrls: string[]): string {
    if (!btih) return ""
    let magnet = "magnet:?xt=urn:btih:" + btih.toLowerCase() + "&dn=" + enc(name)
    const seen: { [k: string]: boolean } = {}
    for (let i = 0; i < trackerUrls.length; i++) {
        const u = trackerUrls[i]
        if (u && !seen[u]) {
            seen[u] = true
            magnet += "&tr=" + enc(u)
        }
    }
    return magnet
}

function dedupeByBtih(arr: TsukihimeTorrent[]): TsukihimeTorrent[] {
    const seen: { [k: string]: boolean } = {}
    const out: TsukihimeTorrent[] = []
    for (let i = 0; i < arr.length; i++) {
        const t = arr[i]
        const key = (t.btih ? t.btih.toLowerCase() : "") || "id:" + t.id
        if (seen[key]) continue
        seen[key] = true
        out.push(t)
    }
    return out
}

class Provider {
    private animeIdCache: { [anilistId: number]: number | null } = {}
    private detailCache: { [id: number]: TsukihimeTorrent | null } = {}
    private trackerPool: string[] = []
    private trackerSeen: { [url: string]: boolean } = {}

    getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: true,
        }
    }

    private apiBase(): string {
        const pref = $getUserPreference("apiUrl")
        const base = pref && pref.length > 0 ? pref : DEFAULT_API
        return stripTrailingSlash(base)
    }

    private includeAdult(): boolean {
        return $getUserPreference("includeAdult") === "true"
    }

    private fetchSeeders(): boolean {
        return $getUserPreference("fetchSeeders") === "true"
    }

    private maxResults(): number {
        return clampInt($getUserPreference("maxResults"), DEFAULT_MAX_RESULTS, 1, MAX_SEARCH_DEPTH)
    }

    private searchDepth(): number {
        return clampInt($getUserPreference("searchDepth"), DEFAULT_SEARCH_DEPTH, this.maxResults(), MAX_SEARCH_DEPTH)
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const q = (opts.query || "").trim()
            if (q.length < 2) return []
            const url = this.apiBase() + "/search/torrents?q=" + enc(q) + "&limit=" + PAGE_SIZE + "&offset=0"
            const torrents = await this.fetchList(url)
            return await this.finalize(torrents, false, false)
        } catch (e) {
            console.log("[tsukihime] search error: " + errMsg(e))
            return []
        }
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const userQuery = (opts.query || "").trim()

            if (userQuery.length >= 2) {
                const t = await this.fetchSearch(userQuery, this.searchDepth())
                return await this.finalize(this.applySmartFilters(t, opts), false, false)
            }

            const internalId = await this.resolveInternalId(opts.media.id)
            if (internalId == null) {
                const title = (opts.media.romajiTitle || opts.media.englishTitle || "").trim()
                if (title.length < 2) return []
                const t = await this.fetchSearch(title, this.searchDepth())
                return await this.finalize(this.applySmartFilters(t, opts), false, false)
            }

            const all = await this.fetchAnimeTorrents(internalId, this.searchDepth())
            return await this.finalize(this.applySmartFilters(all, opts), true, false)
        } catch (e) {
            console.log("[tsukihime] smartSearch error: " + errMsg(e))
            return []
        }
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            let url = this.apiBase() + "/torrents?sort_by=added_date&order=desc&limit=" + PAGE_SIZE + "&offset=0"
            if (!this.includeAdult()) url += "&is_adult=0"
            const torrents = await this.fetchList(url)
            return await this.finalize(torrents, false, true)
        } catch (e) {
            console.log("[tsukihime] getLatest error: " + errMsg(e))
            return []
        }
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return (torrent.infoHash || "").toLowerCase()
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    private async resolveInternalId(anilistId: number): Promise<number | null> {
        if (!anilistId || anilistId <= 0) return null
        if (hasKey(this.animeIdCache, anilistId)) return this.animeIdCache[anilistId]
        try {
            const res = await fetch(this.apiBase() + "/animes/anilist/" + anilistId)
            let resolved: number | null = null
            if (res.ok) {
                const data = res.json<TsukihimeAnime>()
                if (data && typeof data.id === "number") resolved = data.id
            }
            this.animeIdCache[anilistId] = resolved
            return resolved
        } catch (e) {
            console.log("[tsukihime] resolveInternalId error: " + errMsg(e))
            return null
        }
    }

    private async fetchList(url: string): Promise<TsukihimeTorrent[]> {
        const res = await fetch(url)
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url)
        const data = res.json<TsukihimeListResponse>()
        if (!data) return []
        if (data.error === true || (typeof data.error === "string" && data.error.length > 0)) {
            throw new Error("API error: " + data.error)
        }
        return data.results || []
    }

    private async fetchAnimeTorrents(internalId: number, depth: number): Promise<TsukihimeTorrent[]> {
        const out: TsukihimeTorrent[] = []
        let offset = 0
        while (out.length < depth) {
            const url = this.apiBase() + "/animes/" + internalId + "?limit=" + PAGE_SIZE + "&offset=" + offset
            const page = await this.fetchPage(url)
            if (page == null) break
            if (!page.length) break
            for (let i = 0; i < page.length; i++) out.push(page[i])
            if (page.length < PAGE_SIZE) break
            offset += PAGE_SIZE
        }
        return out
    }

    private async fetchSearch(query: string, depth: number): Promise<TsukihimeTorrent[]> {
        const out: TsukihimeTorrent[] = []
        let offset = 0
        while (out.length < depth) {
            const url = this.apiBase() + "/search/torrents?q=" + enc(query) + "&limit=" + PAGE_SIZE + "&offset=" + offset
            const page = await this.fetchPage(url)
            if (page == null) break
            if (!page.length) break
            for (let i = 0; i < page.length; i++) out.push(page[i])
            if (page.length < PAGE_SIZE) break
            offset += PAGE_SIZE
        }
        return out
    }

    private async fetchPage(url: string): Promise<TsukihimeTorrent[] | null> {
        try {
            return await this.fetchList(url)
        } catch (e) {
            console.log("[tsukihime] page fetch failed, stopping pagination: " + errMsg(e))
            return null
        }
    }

    private applySmartFilters(torrents: TsukihimeTorrent[], opts: AnimeSmartSearchOptions): TsukihimeTorrent[] {
        let list = torrents
        const isSingle = opts.media.format === "MOVIE" || opts.media.episodeCount === 1

        if (opts.batch && !isSingle) {
            list = list.filter(function (t) {
                return isBatchTorrent(t)
            })
        } else if (opts.episodeNumber && opts.episodeNumber > 0 && !isSingle) {
            const ep = opts.episodeNumber
            list = list.filter(function (t) {
                if (isBatchTorrent(t)) return batchContainsEpisode(t.name, ep)
                return episodeOf(t) === ep
            })
        }

        if (opts.resolution && opts.resolution.length > 0) {
            list = list.filter(function (t) {
                return resolutionMatches(t.name, opts.resolution)
            })
        }
        return list
    }

    private async finalize(torrents: TsukihimeTorrent[], confirmed: boolean, latest: boolean): Promise<AnimeTorrent[]> {
        const includeAdult = this.includeAdult()
        let list: TsukihimeTorrent[] = []
        for (let i = 0; i < torrents.length; i++) {
            const t = torrents[i]
            if (!t || !t.btih) continue
            if (!includeAdult && isAdultTorrent(t)) continue
            list.push(t)
        }
        list = dedupeByBtih(list)

        list.sort(function (a, b) {
            return (b.source_date || b.added_date || 0) - (a.source_date || a.added_date || 0)
        })

        const maxR = this.maxResults()
        let pool: TsukihimeTorrent[]
        if (latest) {
            pool = list.length > maxR ? list.slice(0, maxR) : list
        } else {
            const depth = this.searchDepth()
            pool = list.length > depth ? list.slice(0, depth) : list
        }

        if (this.fetchSeeders()) await this.enrich(pool)

        let out: AnimeTorrent[] = []
        for (let i = 0; i < pool.length; i++) {
            try {
                out.push(this.toAnimeTorrent(pool[i], confirmed))
            } catch (e) {
                console.log("[tsukihime] skipped bad torrent: " + errMsg(e))
            }
        }

        if (!latest) {
            out.sort(function (a, b) {
                if (b.seeders !== a.seeders) return b.seeders - a.seeders
                return b.size - a.size
            })
            if (out.length > maxR) out = out.slice(0, maxR)
        }
        return out
    }

    private async enrich(list: TsukihimeTorrent[]): Promise<void> {
        let idx = 0
        const self = this
        const worker = async function (): Promise<void> {
            while (true) {
                const i = idx
                idx++
                if (i >= list.length) return
                const t = list[i]
                const detail = await self.fetchDetail(t.id)
                if (detail) {
                    if (detail.trackers) {
                        t.trackers = detail.trackers
                        self.addTrackers(detail.trackers)
                    }
                    if (detail.files) t.files = detail.files
                    if (typeof detail.filecount === "number" && detail.filecount > 0) t.filecount = detail.filecount
                }
            }
        }
        const workers: Promise<void>[] = []
        const n = Math.min(ENRICH_CONCURRENCY, list.length)
        for (let w = 0; w < n; w++) workers.push(worker())
        await Promise.all(workers)
    }

    private addTrackers(trackers: TsukihimeTracker[]): void {
        for (let i = 0; i < trackers.length; i++) {
            const u = trackers[i] && trackers[i].url
            if (u && !this.trackerSeen[u]) {
                this.trackerSeen[u] = true
                this.trackerPool.push(u)
            }
        }
    }

    private async fetchDetail(id: number): Promise<TsukihimeTorrent | null> {
        if (hasKey(this.detailCache, id)) return this.detailCache[id]
        let detail: TsukihimeTorrent | null = null
        try {
            const res = await fetch(this.apiBase() + "/torrents/" + id)
            if (res.ok) {
                const data = res.json<TsukihimeTorrent>()
                if (data) detail = data
            }
        } catch (e) {
            console.log("[tsukihime] detail error for " + id + ": " + errMsg(e))
        }
        this.detailCache[id] = detail
        return detail
    }

    private toAnimeTorrent(t: TsukihimeTorrent, confirmed: boolean): AnimeTorrent {
        const sl = maxSeeders(t.trackers)
        const trackerUrls = trackerUrlsOf(t.trackers).concat(this.trackerPool)
        return {
            name: t.name,
            date: unixToRfc3339(t.source_date, t.added_date),
            size: t.totalsize || 0,
            formattedSize: "",
            seeders: sl.seeders,
            leechers: sl.leechers,
            downloadCount: 0,
            link: sourceLink(t),
            downloadUrl: sourceDownloadUrl(t),
            magnetLink: buildMagnet(t.btih, t.name, trackerUrls),
            infoHash: (t.btih || "").toLowerCase(),
            resolution: "",
            isBatch: isBatchTorrent(t),
            episodeNumber: episodeOf(t),
            releaseGroup: t.group && t.group.name ? t.group.name : "",
            isBestRelease: false,
            confirmed: confirmed,
        }
    }
}
