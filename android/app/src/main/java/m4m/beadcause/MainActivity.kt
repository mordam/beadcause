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
import android.widget.Toast
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
                // The detail drawer loads /doc and /graph into an iframe over the tab
                // you were on (public/drawer.js), and a subframe load arrives here
                // exactly like a tap would. Left alone, or the reader below would open
                // on top of a drawer that stayed empty behind it.
                !request.isForMainFrame -> false
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

        /**
         * Hand the page you are looking at to Chrome.
         *
         * There is otherwise no way out. `shouldOverrideUrlLoading` returns false for
         * our own host on purpose — the console *is* this app — so a link to it, from
         * anywhere inside here, only ever reloads this WebView. That is right for
         * everyday use and wrong for the times the console wants a real browser: the
         * wide layouts a phone never triggers (the split card, the proposal beside the
         * conversation, the drawer as a panel), a terminal with more than forty
         * columns, a graph with room to be read.
         *
         * **The URL is rebuilt here rather than accepted from the page.** Host and
         * token come from [Prefs] and only the path, query and fragment of what the
         * WebView is showing are carried over, so the bridge cannot be talked into
         * launching an arbitrary intent, and Chrome opens on the card you had open
         * rather than at the top of the list.
         *
         * The token has to ride in the URL. Chrome is a different storage context —
         * its localStorage is not this WebView's — so without `?t=` the page would
         * greet you with the token prompt. It is the same shape `npm run qr` prints,
         * and `bootToken()` in app.js strips it back out of the address bar on
         * arrival.
         */
        @JavascriptInterface
        fun openInBrowser() {
            // A @JavascriptInterface method runs on the JavaBridge thread, and both
            // `webView.url` and `startActivity` want the main one.
            runOnUiThread {
                val conn = Prefs.connection(this@MainActivity) ?: return@runOnUiThread
                // A toast rather than the banner: the banner is for a state you are in
                // — notifications off, server unreachable — and stays until something
                // clears it. This is one tap that found nothing, and it should pass.
                if (!Links.openInChrome(this@MainActivity, externalUrl(conn))) {
                    Toast.makeText(this@MainActivity, R.string.no_browser, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /**
     * Where this WebView is, addressed so that a browser with none of its state can
     * arrive at the same place.
     *
     * Every query parameter but the token is carried across, because the page may be
     * a terminal (`/terminal?id=…`) or a graph centred on a bead (`/graph?ws=&id=`),
     * and dropping those lands Chrome on a different screen than the one you asked to
     * see. The token is then appended from prefs — replacing, not duplicating, the one
     * this WebView was launched with.
     */
    private fun externalUrl(conn: Conn): Uri {
        val base = Uri.parse(conn.baseUrl)
        val here = Uri.parse(binding.webView.url ?: conn.baseUrl)
        val out = Uri.Builder()
            .scheme(base.scheme)
            .encodedAuthority(base.encodedAuthority)
            .encodedPath(here.encodedPath?.takeIf { it.isNotEmpty() } ?: "/")
        for (name in here.queryParameterNames) {
            if (name == "t") continue
            here.getQueryParameters(name).forEach { out.appendQueryParameter(name, it) }
        }
        out.appendQueryParameter("t", conn.token)
        here.encodedFragment?.let { out.encodedFragment(it) }
        return out.build()
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
