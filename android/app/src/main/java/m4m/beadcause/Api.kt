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
        }
        return Poll.from(get(conn, "/api/poll", query))
    }

    fun questions(conn: Conn): List<Question> =
        get(conn, "/api/questions").optJSONArray("questions").toQuestions()

    /** Answer and close. */
    fun respond(conn: Conn, workspace: String, id: String, response: String) {
        post(conn, "/api/respond", JSONObject().put("workspace", workspace).put("id", id).put("response", response))
    }

    /** Comment without closing — flags the bead `human-replied` for an agent. */
    fun comment(conn: Conn, workspace: String, id: String, text: String) {
        post(conn, "/api/comment", JSONObject().put("workspace", workspace).put("id", id).put("text", text))
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

data class Option(val id: String, val label: String, val response: String, val hint: String?)

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
) {
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
)

data class Poll(
    val seq: Long,
    val resync: Boolean,
    val events: List<Event>,
    /** Null when the poll timed out with nothing to report — keep what you had. */
    val questions: List<Question>?,
    val workspaces: List<String>,
) {
    companion object {
        fun from(json: JSONObject) = Poll(
            seq = json.optLong("seq"),
            resync = json.optBoolean("resync"),
            events = json.optJSONArray("events").map { it.toEvent() },
            questions = json.optJSONArray("questions")?.toQuestions(),
            workspaces = json.optJSONArray("workspaces").toStringList(),
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
            )
        },
        allowFreeText = decision?.optBoolean("allowFreeText", true) ?: true,
        awaitingAgent = optBoolean("awaitingAgent"),
    )
}

/** org.json turns a JSON null into the string "null"; that is never a value we want. */
private fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
