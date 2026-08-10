-- Open a new iTerm2 window and type a command into it.
--
-- Everything arrives through `argv` rather than being interpolated into the script
-- text. That matters: the command carries a shell-quoted path and a bead id that
-- originate in an HTTP request, and AppleScript string escaping is its own separate
-- minefield on top of shell quoting. With argv there is only one layer to get right,
-- and Node owns it.
--
-- Addressed by bundle id because the app is called "iTerm" on disk but "iTerm2"
-- everywhere else, and which name the scripting bridge answers to has changed
-- between versions.

on run argv
	set theCommand to item 1 of argv
	set theName to item 2 of argv

	tell application id "com.googlecode.iterm2"
		activate
		set newWindow to (create window with default profile)
		tell current session of newWindow
			-- The tab title. Claude renames its own session on the first turn;
			-- this is what labels the window until it does.
			set name to theName
			write text theCommand
			-- The session's own id, printed on stdout for the caller to keep.
			--
			-- It is the only durable handle on this window: the tab name is gone the
			-- moment Claude renames itself, and the pid belongs to the shell rather
			-- than to iTerm. scripts/message-session.applescript takes this id back,
			-- which is what lets the daemon say something to a session it started —
			-- see `messageSession` in lib/session.js.
			return id
		end tell
	end tell
end run
