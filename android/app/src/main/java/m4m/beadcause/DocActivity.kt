package m4m.beadcause

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import m4m.beadcause.databinding.ActivityDocBinding

/**
 * The reader tab, as a real screen.
 *
 * In the browser a `/doc?p=…` link opens a second tab so the question — and any
 * half-written answer — is still there when you come back. Here it's a second
 * activity, which gets the same effect from the system back button.
 *
 * No token is passed in the URL: `doc.html` reads it from localStorage, and this
 * WebView shares the app's storage with MainActivity because it's the same origin.
 */
class DocActivity : AppCompatActivity() {

    private lateinit var binding: ActivityDocBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDocBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val url = intent.data ?: return finish()
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.toolbar.title = url.getQueryParameter("p")?.substringAfterLast('/') ?: getString(R.string.doc_title)

        with(binding.webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
        }

        val host = Uri.parse(Prefs.baseUrl(this).orEmpty()).host
        binding.webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // A doc can link onward. Stay in the reader for our own pages, hand
                // anything else to the browser.
                if (request.url.host == host) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                binding.progress.visibility = View.GONE
                // doc.html carries a header for the browser tab it was written for.
                // Under the native toolbar that's a duplicate title, and its ✕ calls
                // window.close() — which a WebView ignores, so it's a button that
                // does nothing. Drop it. Safe here: doc.js reads #doc-title and
                // #doc-close synchronously while parsing, long before this runs.
                view.evaluateJavascript("document.querySelector('.doc-body > .topbar')?.remove();", null)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) binding.webView.goBack() else finish()
            }
        })

        binding.webView.loadUrl(url.toString())
    }

    override fun onDestroy() {
        binding.webView.destroy()
        super.onDestroy()
    }
}
