package m4m.beadcause

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.WebView
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * The microphone behind the mic button in the answer box.
 *
 * The page cannot do this itself. `public/dictate.js` explains why at length; the
 * short version is that Android WebView has never implemented the Web Speech API, and
 * the daemon serves plain HTTP on a tailnet address, so even a WebView that did
 * implement it would refuse — a browser speech API needs a secure context and there is
 * no certificate to issue to a 100.x host. Dictation on the phone therefore has to be
 * native, and this is the whole of the native part: a [SpeechRecognizer] whose results
 * are pushed into the page as they arrive.
 *
 * It is deliberately one-way about text. Nothing here knows which box is being filled,
 * what a draft is, or where the caret was — the page owns all of that and always has.
 * What crosses the bridge is five events and a string:
 *
 * | event       | means                                                       |
 * |-------------|-------------------------------------------------------------|
 * | `listening` | the microphone is open                                      |
 * | `partial`   | the current best guess at the phrase being spoken           |
 * | `final`     | a phrase the recogniser has committed to                    |
 * | `error`     | it stopped, with a code `dictate.js` turns into a sentence  |
 * | `end`       | it stopped, having been asked to                            |
 *
 * **It keeps listening between phrases.** `SpeechRecognizer` ends the session at the
 * first pause, which would make dictating three sentences three taps on the mic. So a
 * session that ends while you have not tapped stop is started again, bounded by
 * [MAX_RESTARTS] so a device that fails instantly cannot spin forever.
 */
class Dictation(
    private val activity: Activity,
    private val webView: WebView,
    /** Ask for RECORD_AUDIO. The launcher has to live on the activity — see MainActivity. */
    private val askForMicrophone: () -> Unit,
) {

    private companion object {
        /**
         * Restarting is what makes continuous dictation possible and is also the only
         * way this can misbehave, so it is counted. Reset by every phrase actually
         * heard, which means the cap only ever bites on a run that is hearing nothing:
         * roughly a minute of silence, or a recogniser failing on start.
         */
        const val MAX_RESTARTS = 40
        /** Restarting inside the callback that ended the last session is refused. */
        const val RESTART_DELAY_MS = 250L
    }

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    /** True from the tap that started until the tap, or failure, that ends it. */
    private var wanted = false
    private var restarts = 0

    /**
     * Whether there is anything to dictate *with*.
     *
     * A device with no recognition service installed answers false here, and the page
     * then draws no mic at all rather than one that fails on tap. This needs the
     * `<queries>` block in AndroidManifest.xml to see the service at all on Android 11
     * and up — without it this is false everywhere.
     */
    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(activity)

    /** A tap on the mic. Asks for the permission the first time and starts on the grant. */
    fun start() {
        if (!available()) return send("error", "unavailable")
        if (hasMicrophone()) begin() else askForMicrophone()
    }

    /** The answer to that permission dialog, handed back by the activity's launcher. */
    fun onPermission(granted: Boolean) {
        if (granted) begin() else send("error", "denied")
    }

    /**
     * A second tap on the mic.
     *
     * `stopListening` rather than `cancel`: it closes the microphone but still delivers
     * what it heard. The page has already stopped its own run by the time this is
     * called and ignores the late result — it keeps the last partial instead, which is
     * the same words — but a recogniser cancelled mid-utterance can leave the audio
     * session open on some devices, and this is the documented way to end one.
     */
    fun stop() {
        wanted = false
        main.removeCallbacksAndMessages(null)
        try {
            recognizer?.stopListening()
        } catch (_: Exception) {
            /* Already gone. There is nothing to stop. */
        }
        // Said even when the page asked for the stop, because it is also the activity
        // that stops this — backgrounding the app must not leave a mic button lit on a
        // page that thinks it is still listening. A page that stopped itself has
        // already forgotten the run and ignores this.
        send("end")
    }

    /** The activity is going away. A live recogniser holds the microphone until told. */
    fun destroy() {
        wanted = false
        main.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        recognizer = null
    }

    private fun hasMicrophone() =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun begin() {
        wanted = true
        restarts = 0
        listen()
    }

    private fun listen() {
        val rec = recognizer ?: SpeechRecognizer.createSpeechRecognizer(activity).also {
            it.setRecognitionListener(Listener())
            recognizer = it
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            // Without this the box stays empty until you stop talking, and a mic that
            // shows nothing for eight seconds looks broken rather than attentive.
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        }
        try {
            rec.startListening(intent)
        } catch (_: Exception) {
            wanted = false
            send("error", "unavailable")
        }
    }

    /** Another phrase, in the same run. Posted, because startListening inside a callback is refused. */
    private fun again() {
        restarts += 1
        if (restarts > MAX_RESTARTS) {
            wanted = false
            return send("end")
        }
        main.postDelayed({ if (wanted) listen() }, RESTART_DELAY_MS)
    }

    private fun best(results: Bundle?): String? =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    /**
     * Into the page.
     *
     * Guarded on both halves of the path existing: this can fire during a navigation,
     * when `window.beadcause` is whatever the next document has, and an unguarded call
     * would throw inside the WebView on every phrase.
     */
    private fun send(event: String, text: String = "") {
        val js = "window.beadcause && window.beadcause.dictation && " +
            "window.beadcause.dictation.native(${JSONObject.quote(event)},${JSONObject.quote(text)});"
        activity.runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    /**
     * What the recogniser's own codes mean to the page.
     *
     * Deliberately lossy — five outcomes, because the page turns each into a sentence
     * about what to do next and there are only five different things to do. Anything
     * unmapped becomes a plain stop rather than a code nobody can act on.
     */
    private fun codeFor(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
        SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "network"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "busy"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
        SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "unavailable"
        else -> ""
    }

    private inner class Listener : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = send("listening")

        override fun onPartialResults(partialResults: Bundle?) {
            best(partialResults)?.let { send("partial", it) }
        }

        override fun onResults(results: Bundle?) {
            val said = best(results)
            if (said != null) {
                send("final", said)
                // Something was heard, so the run is working: whatever restarts it took
                // to get here are not evidence of a device that cannot listen.
                restarts = 0
            }
            if (wanted) again() else send("end")
        }

        override fun onError(error: Int) {
            // Silence is not a failure. The recogniser ends the session on a long enough
            // pause and reports it as an error; carrying on is the entire point of a
            // dictation that lets you stop and think mid-sentence.
            val quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            if (wanted && quiet) return again()
            wanted = false
            send("error", codeFor(error))
        }

        override fun onBeginningOfSpeech() = Unit
        override fun onEndOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }
}
