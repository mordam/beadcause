-- Close the iTerm2 windows that have no tabs left in them.
--
-- A window with no tabs is a window with no session: nothing to read, nothing running,
-- and no way back into it. It is not a state anything asks for — it is what iTerm
-- occasionally leaves behind when the last session in a window ends. Two were caught on
-- 18 Aug by sampling iTerm every twenty seconds: the `bc-y8k4.4` worker went from a live
-- session on /dev/ttys018 to `tabs=0` inside one sample, and the `viewbar-check` worker
-- did the same two hours later. Both had been signalled by lib/reap.js in the ordinary
-- way, and both were left named `sleep` — the last job of `SENDOFF` in lib/session.js —
-- so the shell got all the way through its send-off and ran `exit`. The session teardown
-- was right; iTerm closed the tab and did not close the window behind it.
--
-- Nothing else in beadcause closes a window. The only close is the shell's own `exit`,
-- so a frame that has already lost its shell is one nothing on this Mac will ever clear:
-- they accumulate until they are dismissed by hand, one red button at a time, and ⌘W
-- does not do it — Close Session is disabled when there is no session, so the keystroke
-- just beeps. That is bc-30ve.
--
-- ## Why this needs none of the guards the signal does
--
-- lib/reap.js keeps four, and every one of them is about not killing an agent that is
-- still working. There is no agent here. A window with zero tabs holds no process, no
-- transcript and no scrollback — the thing those guards protect does not exist in it,
-- and there is no version of "this one was still busy" that can be true. So the test is
-- the whole of the safety argument: `(count of tabs) is 0`, and a window with any tab at
-- all is never touched.
--
-- ## Two passes, and that is not a style choice
--
-- Closing while iterating `windows` renumbers the collection underneath the loop, and
-- iTerm answers `Can't get item 12 of every window. Invalid index. (-1719)` partway
-- through — after it has closed some of them, which is the worst kind of half-done. So
-- the ids are collected first and closed second, addressed by id rather than by index,
-- each in its own `try` so one window that has gone away in the meantime does not cost
-- the rest.
--
-- Never launches iTerm: with iTerm not running there are no windows to close, and a
-- housekeeping sweep that started the terminal in order to tidy it would be worse than
-- the thing it tidies.
--
-- ## Three passes, because `close` lies about these windows
--
-- The first shipped version had two passes and counted an id as closed the moment `close`
-- did not raise. It never once worked, and it announced success 2,330 times: bc-xl7n.110.
-- `try` catches an *error*, and on a zero-tab window iTerm accepts `close` without raising
-- and without removing the window — which is the same iTerm behaviour this header already
-- documents from the other side, that ⌘W is *Close Session* and there is no session here
-- to close. So the number was "windows I sent a close to", and the same ids came back on
-- every tick for four days while the frames sat on the desk.
--
-- The close is therefore no longer its own evidence. The ids are closed in one pass, and
-- then **re-queried by id** — `count of (every window whose id is wid)` — and only a window
-- that is genuinely absent is counted. If the re-query itself fails, the window is reported
-- as stuck: never claim a departure that was not seen.
--
-- ### Why the re-query is a poll and not a single settle
--
-- A window that is really going does not go *at once*. Measured on 2026-08-23 against iTerm
-- 3.6.11: close a window and re-query it in the same `tell` block with no wait at all and
-- iTerm still answers `1`; the id disappears somewhere between there and 50ms, and a batch
-- of three was consistently gone after one 0.05s step (five runs: 0.05, 0.05, 0.05, 0.05,
-- 0.1). So a fixed settle has to be picked, and picking one is picking which way to be
-- wrong — too short and every real closure is announced as stuck, which is this bead's own
-- bug wearing the other sign.
--
-- Polling removes the choice. One settle for the whole batch rather than one per window,
-- because per-window delays are how a ten-window sweep runs out of the caller's five
-- seconds; the loop drops out the moment nothing is left pending, so the ordinary sweep
-- costs a single 0.15s step, and a Mac thrashing hard enough to take longer gets up to
-- 1.2s before anything is called stuck. A window still present after the last step is
-- genuinely not going: that is the finding.
--
-- ### And what it costs when nothing ever goes, which is the case this Mac is actually in
--
-- "One 0.15s step" is the *tidy* case and it is not the steady state. `pending` only empties
-- when a window really leaves, so on a Mac with frames permanently stuck on it — the state
-- this whole script exists because of, and the population bc-xl7n.110 was filed over was ten
-- of them — every tick pays all eight steps and every one of the N re-queries in each of
-- them, for as long as those frames sit on the desk. That is not a ceiling reached under
-- load; it is the bill, on every tick, indefinitely. bc-xl7n.131.2.
--
-- Measured 2026-08-24 against iTerm 3.6.11, 22 windows on the desk, by seeding this script's
-- own poll with ids that never go away — a stuck window and a live one are indistinguishable
-- to `count of (every window whose id is wid)`, so the all-stuck cost is measurable without
-- the one state that cannot be staged:
--
--   N=1   1.44s      N=3   1.43s      N=10  1.63s      N=15  1.66s
--
-- against the caller's five-second timeout. The fixed 1.2s of `delay` is ~75% of the call
-- and the part that scales with N is ~15ms a window — so the eight-times-N re-queries, which
-- look like the expensive half, are under 1% of it at N=10. It would take on the order of two
-- hundred stuck frames to reach five seconds, and iTerm on this Mac holds twenty-odd windows
-- in total. test/cards.mjs pins the 1.2s against that timeout so the two cannot drift apart.
--
-- **No early exit, and that is a decision rather than an omission.** The only thing left to
-- save is the 1.05s between the first step and the eighth, and it can only be saved by
-- calling a batch stuck before the eighth — which is guessing "stuck" from "slow", the exact
-- guess the poll was written to remove. There is no signal that separates them: a window that
-- refuses and a window that is taking its time both answer `1`, and getting it wrong is this
-- script's own history with the sign reversed. Two safe savings were measured and both are
-- too small to buy the complexity — asking `id of every window` once a step instead of once
-- a window saves ~40ms at N=10 and trades a per-window failure for a whole-step one, and
-- carrying the daemon's already-known stuck ids in so they skip the wait would save the full
-- 1.05s but needs a state channel into a script that is deliberately stateless. If the cost
-- ever matters, that second one is the design; at 1.6s inside a thirty-second tick it does
-- not.
--
-- The later passes walk their list by index rather than as `repeat with x in doomed`,
-- because that form binds a *reference* to the list item and the usual way to dereference
-- one — `contents of x` — is not available here: inside `tell application iTerm2`,
-- `contents` is iTerm's own term for a session's text, so it answers
-- `Can't get contents of 69571 (-1728)`. `item i of doomed` is a plain value and needs no
-- dereference at all.
--
-- ## What it does not do, deliberately
--
-- It does not try a second verb on the ones that would not go. There is no way to make a
-- zero-tab window on demand — `close` of a window's last tab closes the window, and so does
-- SIGKILLing its shell (both measured on 2026-08-23, iTerm 3.6.11); they appear only when
-- iTerm loses one on its own. So any second verb would ship unverified, which is exactly
-- how the first version of this got to 2,330 false successes. The honest report below is
-- what will say whether *anything* here closes, and that measurement is what a second verb
-- would need before it is worth writing.
--
-- Prints the number closed, then their ids, space separated: `2 42590 42729`, or `0`. If
-- any window was asked to close and did not, a second line names them: `stuck 47768 47792`.

on run
	if not (application id "com.googlecode.iterm2" is running) then return "0"

	tell application id "com.googlecode.iterm2"
		set doomed to {}
		repeat with w in windows
			try
				if (count of tabs of w) is 0 then set end of doomed to (id of w)
			end try
		end repeat

		repeat with i from 1 to (count of doomed)
			try
				close (first window whose id is (item i of doomed))
			end try
		end repeat

		set closedIds to {}
		set pending to doomed
		repeat 8 times
			if (count of pending) is 0 then exit repeat
			tell current application to delay 0.15
			set stillPending to {}
			repeat with i from 1 to (count of pending)
				set wid to item i of pending
				set stillThere to true
				try
					if (count of (every window whose id is wid)) is 0 then set stillThere to false
				end try
				if stillThere then
					set end of stillPending to wid
				else
					set end of closedIds to (wid as text)
				end if
			end repeat
			set pending to stillPending
		end repeat

		set stuckIds to {}
		repeat with i from 1 to (count of pending)
			set end of stuckIds to ((item i of pending) as text)
		end repeat
	end tell

	set AppleScript's text item delimiters to " "
	set out to ((count of closedIds) as text)
	if (count of closedIds) > 0 then set out to out & " " & (closedIds as text)
	if (count of stuckIds) > 0 then set out to out & linefeed & "stuck " & (stuckIds as text)
	set AppleScript's text item delimiters to ""
	return out
end run
