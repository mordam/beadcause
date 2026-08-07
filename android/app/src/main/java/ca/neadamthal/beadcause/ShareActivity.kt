package ca.neadamthal.beadcause

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import ca.neadamthal.beadcause.databinding.ActivityShareBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Share sheet → a `human` bead.
 *
 * Anything on the phone — a link, a quoted paragraph, a thought typed into a notes
 * app — becomes a question sitting in the same inbox as everything an agent asks,
 * so it gets dealt with in the same pass instead of in a second place.
 *
 * The server suppresses the ntfy push for these, since you filed it yourself and are
 * looking at the screen.
 */
class ShareActivity : AppCompatActivity() {

    private lateinit var binding: ActivityShareBinding
    private var workspaces: List<String> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Prefs.isPaired(this)) {
            Toast.makeText(this, R.string.share_not_paired, Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }

        binding = ActivityShareBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val shared = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim()

        // A shared link has no subject and no obvious title; the first line of the
        // text is the best guess, trimmed to something that reads as a title.
        binding.title.setText(subject?.takeIf { it.isNotBlank() } ?: shared.lineSequence().firstOrNull()?.take(80).orEmpty())
        binding.body.setText(shared)

        binding.cancel.setOnClickListener { finish() }
        binding.file.setOnClickListener { file() }

        loadWorkspaces()
    }

    /**
     * `/api/health` lists the workspaces and needs no token, so the picker is
     * populated before anything else can fail.
     */
    private fun loadWorkspaces() {
        val conn = Prefs.connection(this) ?: return finish()
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Api.health(conn.baseUrl) } }
            result.onSuccess { names ->
                workspaces = names
                binding.workspace.adapter =
                    ArrayAdapter(this@ShareActivity, android.R.layout.simple_spinner_dropdown_item, names)
                // Default to wherever the last one went — usually the same project.
                Prefs.lastWorkspace(this@ShareActivity)?.let { last ->
                    names.indexOf(last).takeIf { it >= 0 }?.let(binding.workspace::setSelection)
                }
                binding.file.isEnabled = true
            }.onFailure {
                binding.status.text = getString(R.string.share_offline)
                binding.status.visibility = View.VISIBLE
            }
        }
    }

    private fun file() {
        val conn = Prefs.connection(this) ?: return
        val workspace = workspaces.getOrNull(binding.workspace.selectedItemPosition) ?: return
        val title = binding.title.text?.toString()?.trim().orEmpty()
        val body = binding.body.text?.toString()?.trim().orEmpty()
        if (title.isBlank()) {
            binding.title.error = getString(R.string.share_need_title)
            return
        }

        binding.file.isEnabled = false
        binding.status.text = getString(R.string.share_filing)
        binding.status.visibility = View.VISIBLE

        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Api.ask(conn, workspace, title, body) } }
            result.onSuccess { key ->
                Prefs.setLastWorkspace(this@ShareActivity, workspace)
                Toast.makeText(this@ShareActivity, getString(R.string.share_filed, key), Toast.LENGTH_SHORT).show()
                finish()
            }.onFailure { e ->
                binding.file.isEnabled = true
                binding.status.text = getString(R.string.share_failed, e.message.orEmpty())
            }
        }
    }
}
