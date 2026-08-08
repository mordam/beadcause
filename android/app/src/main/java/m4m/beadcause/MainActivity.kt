package m4m.beadcause

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import m4m.beadcause.databinding.ActivityMainBinding
import org.json.JSONObject

/**
 * The app is the PWA.
 *
 * Every hard-won behaviour — the two-tap confirm, per-keystroke draft persistence,
 * the render deferral that stops the list rebuilding under a half-typed answer,
 * markdown, mermaid, the document reader — already exists in `public/app.js` and is
 * one WebView away. Re-implementing that in Compose would have meant maintaining
 * two of everything and re-learning the same UX lessons the hard way.
 *
 * What this class adds is the part a web page cannot do: notifications with a typed
 * reply, a share target, and a watcher that survives the tab being killed.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_KEY = "key"
    }

    private lateinit var binding: ActivityMainBinding
    private var serverHost: String? = null
    private var loaded = false

    private val pairing = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (Prefs.isPaired(this)) startUp() else finish()
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                // Not fatal — the app still works, it just can't be the thing that
                // tells you a decision is waiting, which is most of the point.
                binding.banner.text = getString(R.string.notifications_denied)
                binding.banner.visibility = View.VISIBLE
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        Notifications.ensureChannels(this)
        configureWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) binding.webView.goBack() else finish()
            }
        })

        if (Prefs.isPaired(this)) startUp() else pairing.launch(Intent(this, PairActivity::class.java))
    }

    private fun startUp() {
        askForNotifications()
        WatchService.start(this)
        load(intent.getStringExtra(EXTRA_KEY))
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /* -------------------------------------------------------------- webview */

    private fun configureWebView() = with(binding.webView.settings) {
        javaScriptEnabled = true
        // localStorage is where the token and — more importantly — every in-progress
        // answer draft lives. Without this, backgrounding the app loses answers.
        domStorageEnabled = true
        loadWithOverviewMode = true
        useWideViewPort = true
        mediaPlaybackRequiresUserGesture = false
        // Links open via shouldOverrideUrlLoading instead of spawning WebViews we'd
        // have to manage; the PWA's target=_blank links become DocActivity or a
        // Custom Tab, both of which sit on top of this one and hand it back intact.
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
        cacheMode = WebSettings.LOAD_DEFAULT
        userAgentString = "$userAgentString Beadcause/${BuildConfig.VERSION_NAME}"

        // Named so it can't be confused with `window.beadcause`, which is the page's
        // own export in the other direction.
        binding.webView.addJavascriptInterface(Bridge(), "BeadcauseNative")
        binding.webView.webViewClient = Client()
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            val isOurs = url.host != null && url.host == serverHost
            return when {
                // The reader tab. Opening it on top keeps your place in the list —
                // and any answer you'd started typing — exactly where it was.
                isOurs && url.path?.startsWith("/doc") == true -> {
                    startActivity(Intent(this@MainActivity, DocActivity::class.java).setData(url))
                    true
                }
                isOurs -> false
                // Anything off the server is a link out of a brief. `Links` keeps
                // web pages inside the app in a Custom Tab — signed in, and back
                // returns you to this card — and lets the system have the rest.
                else -> {
                    Links.open(this@MainActivity, url)
                    true
                }
            }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            binding.progress.visibility = View.GONE
            loaded = true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            binding.progress.visibility = View.GONE
            // The overwhelmingly likely cause is being off the tailnet; say that
            // rather than surfacing a WebView error code.
            binding.banner.text = getString(R.string.cannot_reach_server, Prefs.baseUrl(this@MainActivity).orEmpty())
            binding.banner.visibility = View.VISIBLE
        }
    }

    /** What the page can call back into. Deliberately tiny. */
    private inner class Bridge {
        /**
         * The page just closed a question. Clear its notification now rather than
         * waiting for the poll — otherwise answering in the app leaves a live
         * notification whose buttons would answer an already-closed bead.
         */
        @JavascriptInterface
        fun answered(key: String) {
            Notifications.cancel(this@MainActivity, key)
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    /* ----------------------------------------------------------------- load */

    private fun load(key: String?) {
        val conn = Prefs.connection(this) ?: return
        serverHost = Uri.parse(conn.baseUrl).host
        binding.banner.visibility = View.GONE
        binding.progress.visibility = View.VISIBLE
        // The `?t=` is the same pairing URL shape the QR carries; `bootToken()` in
        // app.js stores it and strips it back out of the address bar.
        val fragment = key?.let { "#" + Uri.encode(it) }.orEmpty()
        binding.webView.loadUrl("${conn.baseUrl}/?t=${Uri.encode(conn.token)}$fragment")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val key = intent.getStringExtra(EXTRA_KEY) ?: return
        if (!loaded) return load(key)
        // Reloading would throw away scroll position and any draft in a textarea, so
        // move the hash instead and let the page's own hashchange handler scroll to it.
        val quoted = JSONObject.quote(key)
        binding.webView.evaluateJavascript(
            "(function(){var h='#'+encodeURIComponent($quoted);" +
                "if(location.hash===h){location.hash='';}location.hash=h;})();",
            null,
        )
    }

    override fun onResume() {
        super.onResume()
        binding.webView.onResume()
        // Came back from the shade or from a doc; pull fresh questions. `refresh` is
        // exported by app.js for exactly this. It's a no-op if a card is mid-answer.
        if (loaded) binding.webView.evaluateJavascript("window.beadcause && window.beadcause.refresh();", null)
    }

    override fun onPause() {
        binding.webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        binding.webView.destroy()
        super.onDestroy()
    }
}
