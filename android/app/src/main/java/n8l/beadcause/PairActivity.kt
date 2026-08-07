package n8l.beadcause

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import n8l.beadcause.databinding.ActivityPairBinding
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pairing.
 *
 * `npm run qr` prints a QR of `http://<tailscale-ip>:4318/?t=<token>` — the same URL
 * the PWA is added to the home screen from. Scanning it here is the whole setup:
 * host and token come out of one string. Typing it is the fallback, and accepts
 * either that full URL pasted whole or an address and token separately.
 */
class PairActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPairBinding
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    /** A QR stays in frame for many frames; only the first one may start a pairing. */
    private val claimed = AtomicBoolean(false)

    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    )

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else showManualOnly(getString(R.string.camera_denied))
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPairBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.connect.setOnClickListener { pairFromForm() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onDestroy() {
        analysisExecutor.shutdown()
        scanner.close()
        super.onDestroy()
    }

    private fun showManualOnly(reason: String) {
        binding.preview.visibility = View.GONE
        binding.scanHint.text = reason
    }

    /* ---------------------------------------------------------------- camera */

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = try {
                future.get()
            } catch (e: Exception) {
                Log.w("Beadcause", "no camera: ${e.message}")
                return@addListener showManualOnly(getString(R.string.camera_unavailable))
            }

            val preview = Preview.Builder().build().also { it.surfaceProvider = binding.preview.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(analysisExecutor, ::analyze) }

            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                Log.w("Beadcause", "camera bind failed: ${e.message}")
                showManualOnly(getString(R.string.camera_unavailable))
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun analyze(proxy: androidx.camera.core.ImageProxy) {
        val media = proxy.image
        if (media == null || claimed.get()) {
            proxy.close()
            return
        }
        scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
            .addOnSuccessListener { codes ->
                val raw = codes.firstNotNullOfOrNull { it.rawValue } ?: return@addOnSuccessListener
                val pairing = parsePairingUrl(raw) ?: return@addOnSuccessListener
                if (claimed.compareAndSet(false, true)) {
                    runOnUiThread { verifyAndSave(pairing.first, pairing.second) }
                }
            }
            .addOnCompleteListener { proxy.close() }
    }

    /* ------------------------------------------------------------ manual entry */

    private fun pairFromForm() {
        val address = binding.address.text?.toString()?.trim().orEmpty()
        val typedToken = binding.token.text?.toString()?.trim().orEmpty()

        // Pasting the whole pairing URL into the address box is the obvious thing to
        // do, so make it work rather than complaining about a token in the address.
        parsePairingUrl(address)?.let { (base, token) -> return verifyAndSave(base, token) }

        if (address.isBlank() || typedToken.isBlank()) {
            return status(getString(R.string.pair_need_both), error = true)
        }
        val normalized = if (address.startsWith("http")) address else "http://$address"
        val base = normalized.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}:${it.port}" }
            ?: return status(getString(R.string.pair_bad_address), error = true)
        verifyAndSave(base, typedToken)
    }

    /** `http://100.96.105.106:4318/?t=<token>` → base URL and token. */
    private fun parsePairingUrl(raw: String): Pair<String, String>? {
        val url = raw.trim().toHttpUrlOrNull() ?: return null
        val token = url.queryParameter("t")?.takeIf { it.isNotBlank() } ?: return null
        return "${url.scheme}://${url.host}:${url.port}" to token
    }

    /* -------------------------------------------------------------- verifying */

    /**
     * Check the address and the token separately, because they fail for completely
     * different reasons: a wrong address means the server isn't there (or you're off
     * the tailnet), a wrong token means it is there and said no.
     */
    private fun verifyAndSave(baseUrl: String, token: String) {
        // The token is a bearer credential for every workspace at once. Sending it in
        // the clear to anything but the tailnet — a typo, a stale LAN address, a QR
        // photographed from someone else's screen — is the one mistake here with
        // consequences, so refuse before the first request rather than after.
        if (!isPrivateAddress(baseUrl)) {
            claimed.set(false)
            return status(getString(R.string.pair_not_private), error = true)
        }

        binding.connect.isEnabled = false
        status(getString(R.string.pair_checking, baseUrl), error = false)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    Api.health(baseUrl)
                    Api.verify(Conn(baseUrl, token))
                }
            }
            binding.connect.isEnabled = true
            result.onSuccess { workspaces ->
                Prefs.pair(this@PairActivity, baseUrl, token)
                WatchService.start(this@PairActivity)
                status(getString(R.string.pair_ok, workspaces.size), error = false)
                setResult(RESULT_OK)
                // Re-pairing is also reachable straight from the "token rejected"
                // notification, with no MainActivity underneath to return to.
                if (callingActivity == null) {
                    startActivity(android.content.Intent(this@PairActivity, MainActivity::class.java))
                }
                finish()
            }.onFailure { e ->
                claimed.set(false)
                status(
                    when {
                        Api.isUnauthorized(e) -> getString(R.string.pair_bad_token)
                        else -> getString(R.string.pair_unreachable, baseUrl, e.message.orEmpty())
                    },
                    error = true,
                )
            }
        }
    }

    /**
     * HTTPS anywhere is fine. Cleartext is only allowed to Tailscale's CGNAT range
     * (100.64.0.0/10) and loopback — including 10.0.2.2, which is how an emulator
     * reaches the Mac it's running on.
     *
     * This is the check `network_security_config.xml` cannot express: that file
     * matches hostnames by DNS suffix, so no entry in it can describe an IP range.
     */
    private fun isPrivateAddress(baseUrl: String): Boolean {
        val url = baseUrl.toHttpUrlOrNull() ?: return false
        if (url.scheme == "https") return true
        val host = url.host
        if (host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2") return true
        val octets = host.split('.').mapNotNull { it.toIntOrNull() }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        return octets[0] == 100 && octets[1] in 64..127
    }

    private fun status(text: String, error: Boolean) {
        binding.status.text = text
        binding.status.visibility = View.VISIBLE
        binding.status.setTextColor(
            ContextCompat.getColor(this, if (error) R.color.error else R.color.muted)
        )
    }
}
