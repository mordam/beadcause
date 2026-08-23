package m4m.beadcause

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The beadcause HTTP API.
 *
 * Parsed with org.json rather than a serialization library on purpose: native code
 * only ever reads the handful of fields a notification needs — key, title, option
 * labels. Everything rich (markdown, mermaid, images, the doc reader) is rendered
 * by the PWA inside the WebView, so mirroring the full question schema into Kotlin
 * data classes would be a second copy to keep in step for no benefit.
 */
object Api {

    /**
     * `readTimeout` has to outlast the server's longest park. `/api/poll?wait=25`
     * holds for 25s, so a 30s read timeout would race it; 60s leaves room for the
     * `bd human list` across five workspaces that follows a wake-up.
     */
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    class ApiException(val code: Int, message: String) : IOException(message)

    /** 401 means the token was rotated or the config regenerated — re-pair, don't retry. */
    fun isUnauthorized(e: Throwable) = e is ApiException && e.code == 401

    private fun url(conn: Conn, path: String): HttpUrl.Builder =
        (conn.baseUrl + path).toHttpUrlOrNull()?.newBuilder()
            ?: throw IOException("bad server address: ${conn.baseUrl}")

    private fun call(conn: Conn?, request: Request.Builder): String {
        val req = request.apply { conn?.let { header("x-beadcause-token", it.token) } }.build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val detail = runCatching { JSONObject(body).optString("error") }.getOrNull()
                throw ApiException(res.code, detail?.takeIf { it.isNotBlank() } ?: "HTTP ${res.code}")
            }
            return body
        }
    }

    private fun get(conn: Conn, path: String, query: Map<String, String> = emptyMap()): JSONObject {
        val u = url(conn, path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        return JSONObject(call(conn, Request.Builder().url(u)))
    }

    private fun post(conn: Conn, path: String, body: JSONObject): JSONObject {
        val u = url(conn, path).build()
        return JSONObject(call(conn, Request.Builder().url(u).post(body.toString().toRequestBody(JSON))))
    }

    /**
     * Does this address speak beadcause? `/api/health` is the one unauthenticated
     * endpoint, so pairing can tell "wrong address" from "wrong token" — which are
     * very different things to put in front of someone at a QR screen.
     */
    fun health(baseUrl: String): List<String> {
        val u = ("${baseUrl.trimEnd('/')}/api/health").toHttpUrlOrNull()
            ?: throw IOException("bad server address: $baseUrl")
        val json = JSONObject(call(null, Request.Builder().url(u)))
        if (!json.optBoolean("ok")) throw IOException("not a beadcause server")
        return json.optJSONArray("workspaces").toStringList()
    }

    /** Proves the token as well as the address. */
    fun verify(conn: Conn): List<String> = get(conn, "/api/questions").optJSONArray("workspaces").toStringList()

    /**
     * Long-poll. Pass the previous response's [since]; the call parks server-side
     * until something happens or [waitSeconds] elapse. Pass `since = null` for a
     * cold read: current state, current sequence, and no event backlog — which is
     * how the service avoids notifying for every question already waiting.
     */
    fun poll(conn: Conn, since: Long?, waitSeconds: Int = 25): Poll {
        val query = buildMap {
            since?.let { put("since", it.toString()) }
            put("wait", waitSeconds.toString())
            // "I own a notification shade, and I can cancel a row in it later."
            //
            // The one client that can say that. The PWA draws no shade, and the
            // terminal monitor parks on this same endpoint from the Mac — so without
            // this flag the daemon could not tell "a phone is watching" from "a log
            // window is open", and would offer to clear notifications that do not
            // exist. See lib/ringing.js.
            put("shade", "1")
        }
        return Poll.from(get(conn, "/api/poll", query))
    }

    fun questions(conn: Conn): List<Question> =
        get(conn, "/api/questions").optJSONArray("questions").toQuestions()

    /**
     * Answer, and close unless the bead says otherwise.
     *
     * [option] is the id of the tapped option button, absent for a typed reply. It
     * exists for the one thing the sentence cannot carry: an option marked
     * `closes: false` commissions work rather than settling it, and answering with
     * one leaves the bead open and hands it back. The server reads that off the bead
     * — the id is all this has to send. Returns the response so the caller can say
     * which of the two happened; `closed` is false on a hand-back.
     */
    fun respond(conn: Conn, workspace: String, id: String, response: String, option: String? = null): JSONObject =
        post(
            conn,
            "/api/respond",
            JSONObject().put("workspace", workspace).put("id", id).put("response", response).apply {
                option?.takeIf { it.isNotBlank() }?.let { put("option", it) }
            },
        )

    /** Comment without closing — flags the bead `human-replied` for an agent. */
    fun comment(conn: Conn, workspace: String, id: String, text: String) {
        post(conn, "/api/comment", JSONObject().put("workspace", workspace).put("id", id).put("text", text))
    }

    /**
     * What the daemon says the published APK is, and what the last deploy did.
     *
     * The same `/api/update` the pages read (lib/update.js). The shell asks it for one
     * field — `apk.versionCode` — and asks for itself rather than being handed the page's
     * copy, because the download that follows is the shell's own act: a WebView that has
     * been talked into naming a different build is a WebView that has talked the phone
     * into installing one.
     */
    fun update(conn: Conn): JSONObject = get(conn, "/api/update")

    /**
     * Pull a file off the server onto disk — the APK, and nothing else so far.
     *
     * Streamed rather than buffered: it is around 28 MB and the phone this runs on has no
     * reason to hold that twice. Written to a `.part` and renamed only after the length
     * agrees with what was advertised, so a download cut off halfway by a tailnet dropping
     * cannot leave a plausible-looking APK behind for the installer to choke on. The
     * caller owns both paths; this owns the bytes and the check.
     *
     * `expectedSize` of 0 means the caller was not told a size, which happens with a
     * published APK that has no sidecar beside it. Then the length check is skipped —
     * unknown is not a mismatch — and the installer's own signature and manifest checks
     * are what stand behind it.
     */
    fun downloadTo(conn: Conn, path: String, dest: java.io.File, expectedSize: Long = 0): Long {
        val u = url(conn, path).build()
        val req = Request.Builder().url(u).header("x-beadcause-token", conn.token).build()
        val part = java.io.File(dest.parentFile, "${dest.name}.part")
        part.parentFile?.mkdirs()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "HTTP ${res.code} fetching $path")
            val body = res.body ?: throw IOException("empty response fetching $path")
            part.outputStream().use { out -> body.byteStream().copyTo(out, 64 * 1024) }
        }
        val got = part.length()
        if (expectedSize > 0 && got != expectedSize) {
            part.delete()
            throw IOException("downloaded $got bytes of an expected $expectedSize — the link dropped")
        }
        dest.delete()
        if (!part.renameTo(dest)) throw IOException("could not put the download in place at ${dest.name}")
        return got
    }

    /** File a new `human` question. Backs the share target. */
    fun ask(conn: Conn, workspace: String, title: String, body: String, priority: Int = 1): String {
        val res = post(
            conn,
            "/api/ask",
            JSONObject().put("workspace", workspace).put("title", title).put("body", body).put("priority", priority),
        )
        return res.optString("key")
    }
}

/* ------------------------------------------------------------------ models */

/**
 * [closes] is false for an option that commissions work — "Build both as written" —
 * which answers without closing the bead. The shade only has to carry the flag as
 * far as the label it draws; the decision itself is the server's, off the bead.
 */
data class Option(val id: String, val label: String, val response: String, val hint: String?, val closes: Boolean = true)

data class Question(
    val workspace: String,
    val id: String,
    val key: String,
    val title: String,
    val question: String,
    val priority: Int?,
    val options: List<Option>,
    val allowFreeText: Boolean,
    val awaitingAgent: Boolean,
    /**
     * An agent asking to change what it is, rather than a question about work.
     *
     * The two arrive over the same wire and are answered by the same endpoint —
     * everything underneath is shared — but they are different kinds of decision
     * and the phone keeps them in different places: a pane of its own in the app,
     * and a card of its own in the shade. See [Tray.Chan].
     */
    val foundation: Boolean = false,
    /** Which agent is asking, and how far the change reaches. Null unless [foundation]. */
    val amendmentAgent: String? = null,
    val amendmentScope: String? = null,
    /**
     * What you said the last time this bead was a question, or null — which is almost
     * always, because it is only set when answering this bead closed it and something
     * has since reopened it.
     *
     * It matters most here, of all the surfaces. The shade offers the first three
     * options as buttons, so a question that has come back can be answered identically
     * from a lock screen without the card ever being opened — which is precisely how
     * beadcause/bc-goo.2 collected the same answer twice an hour apart. See
     * lib/answered.js on the daemon side.
     */
    val answeredAt: String? = null,
    val answeredResponse: String? = null,
    val answeredCount: Int = 0,
) {
    /** Has this bead been round the inbox before? */
    val answeredBefore: Boolean get() = answeredAt != null || answeredResponse != null

    /** Stable across restarts, so an update replaces rather than stacks. */
    val notificationId: Int get() = key.hashCode()
}

data class Event(
    val seq: Long,
    val type: String,
    val key: String?,
    val workspace: String?,
    val id: String?,
    val title: String?,
    val author: String?,
    val text: String?,
    /** The space this belongs to, or null when spaces aren't configured. */
    val space: String?,
    /**
     * Nothing should light up the phone for this one.
     *
     * The event still arrives — the question must appear in the list and the badge
     * — but nothing should light up the phone for it. Suppressing the event instead
     * would hide the question outright, which is a far worse failure than a buzz.
     */
    val quiet: Boolean,
    /**
     * Why: `"addressed"` (the question names somebody who is not this Mac's person),
     * `"filtered"` (outside what the inbox is narrowed to) or `"muted"` (the owning
     * space is muted or inside its quiet hours). Null when it made a noise, and null
     * from a server too old to say — which is why [quiet] stays the field anything acts
     * on, and this one only says how to describe it.
     */
    val quietReason: String?,
    /**
     * Why a `dismissed` event happened — `"filtered"` (the inbox was narrowed past this
     * bead) or `"addressed"` (the question was handed to somebody else from the card, so
     * it has stopped being this Mac's to answer).
     *
     * Separate from [quietReason], which says why the phone stayed *dark* for an
     * arrival. This says why a row already in the shade was taken away, and the two
     * would be confusing to read off one field even where they use the same word. Null
     * from a server too old to send it. Nothing branches on the value — the row goes
     * either way — so a reason this shell has never heard of is logged and obeyed.
     */
    val reason: String?,
    /**
     * `"stuck"` or `"clear"`, on a `stuck` event and nothing else.
     *
     * The one event kind in this app that is a *state* rather than an arrival. A
     * question, a reply and a landing all happened and stay happened; a deploy that
     * failed or a tracker that stopped syncing is a condition, and the card that says so
     * has to go away when the condition does. Same type, same key, `clear` instead of
     * `stuck` — see lib/news.js.
     *
     * Null on every other type and from a server too old to send it, which is why the
     * consumer treats *anything but* `"clear"` as still stuck: an unrecognised value
     * leaves the warning up, and that is the safe direction for this one.
     */
    val state: String?,
    /**
     * Which subsystem is stuck — `"deploy"` or `"sync"`. Carried so a card can say so
     * without parsing [title], and so a future kind of blockage is a new value here
     * rather than a new event type. Nothing branches on it today.
     */
    val source: String?,
)

data class Poll(
    val seq: Long,
    val resync: Boolean,
    val events: List<Event>,
    /** Null when the poll timed out with nothing to report — keep what you had. */
    val questions: List<Question>?,
    /**
     * The foundation channel, sent apart from [questions] and never folded into it.
     *
     * Null on a quiet poll, exactly like [questions] — an empty channel and an
     * uneventful minute are different facts, and confusing them would clear the
     * shade every time nothing happened.
     */
    val requests: List<Question>?,
    val workspaces: List<String>,
    /**
     * Every card `stuck_v1` should be showing right now — not a transition, a snapshot.
     *
     * [Event.state] on each of these is never `"clear"`; a condition that has cleared
     * is simply absent from the list. Sent on every poll, unlike [questions]/[requests]
     * — building it costs the daemon no `bd` call, so there is no timed-out poll worth
     * skipping it on, and skipping it on exactly the poll where nothing else changed is
     * bc-ka5y.15.8: the one poll a phone makes right after a restart, with its tray
     * empty and the thing it was warning about still true.
     *
     * Null from a server too old to send it, same as every other field a client this
     * old has never heard of — [WatchService] treats that as "say nothing", which is
     * the safe direction: a card this build cannot restore is no worse than the bug
     * this field exists to fix, never worse than what shipped before it.
     */
    val stuck: List<Event>?,
) {
    /** Both channels together, for the lookups that only need "is this bead live". */
    val allBeads: List<Question> get() = questions.orEmpty() + requests.orEmpty()

    companion object {
        fun from(json: JSONObject) = Poll(
            seq = json.optLong("seq"),
            resync = json.optBoolean("resync"),
            events = json.optJSONArray("events").map { it.toEvent() },
            questions = json.optJSONArray("questions")?.toQuestions(),
            requests = json.optJSONArray("requests")?.toQuestions(),
            workspaces = json.optJSONArray("workspaces").toStringList(),
            stuck = json.optJSONArray("stuck")?.map { it.toEvent() },
        )
    }
}

/* ------------------------------------------------------------- json helpers */

private inline fun <T> JSONArray?.map(transform: (JSONObject) -> T): List<T> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optJSONObject(it) }.map(transform)
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
}

private fun JSONArray?.toQuestions(): List<Question> = map { it.toQuestion() }

private fun JSONObject.toEvent() = Event(
    seq = optLong("seq"),
    type = optString("type"),
    key = optStringOrNull("key"),
    workspace = optStringOrNull("workspace"),
    id = optStringOrNull("id"),
    title = optStringOrNull("title"),
    author = optStringOrNull("author"),
    text = optStringOrNull("text"),
    space = optStringOrNull("space"),
    quiet = optBoolean("quiet"),
    quietReason = optStringOrNull("quietReason"),
    reason = optStringOrNull("reason"),
    state = optStringOrNull("state"),
    source = optStringOrNull("source"),
)

private fun JSONObject.toQuestion(): Question {
    val decision = optJSONObject("decision")
    val workspace = optString("workspace")
    val id = optString("id")
    return Question(
        workspace = workspace,
        id = id,
        key = optStringOrNull("key") ?: "$workspace/$id",
        title = optString("title"),
        // `question` is the decision block's own prompt; it's absent when the block
        // failed to parse, and the bead title is the only thing left to show.
        question = optStringOrNull("question") ?: decision?.optStringOrNull("question") ?: optString("title"),
        priority = if (isNull("priority")) null else optInt("priority"),
        options = decision?.optJSONArray("options").map {
            Option(
                id = it.optString("id"),
                label = it.optString("label"),
                // An option with no explicit response answers with its own label.
                response = it.optStringOrNull("response") ?: it.optString("label"),
                hint = it.optStringOrNull("hint"),
                // Absent on a server older than this field, and absence has to mean
                // "closes" — that was the only behaviour there has ever been.
                closes = it.optBoolean("closes", true),
            )
        },
        allowFreeText = decision?.optBoolean("allowFreeText", true) ?: true,
        awaitingAgent = optBoolean("awaitingAgent"),
        // The server sets `foundation` from the bead's label rather than from whether
        // the amendment block parsed, so a malformed request still arrives in the
        // right channel — carrying its error — instead of falling into the work feed.
        foundation = optBoolean("foundation"),
        amendmentAgent = optJSONObject("amendment")?.optStringOrNull("agent"),
        amendmentScope = optJSONObject("amendment")?.optStringOrNull("scope"),
        answeredAt = optJSONObject("answeredBefore")?.optStringOrNull("at"),
        answeredResponse = optJSONObject("answeredBefore")?.optStringOrNull("response"),
        answeredCount = optJSONObject("answeredBefore")?.optInt("count") ?: 0,
    )
}

/** org.json turns a JSON null into the string "null"; that is never a value we want. */
private fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
