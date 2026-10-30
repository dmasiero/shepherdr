# Current model and effort

The composer shows native CLI observations separately from selected launch settings.
A configured model or catalog default is not evidence of what a turn actually used.
Missing observations say Not reported. Restart keeps the recorded running agent and
requested replacement distinct.

Claude Code observations come from its main assistant records and whitelisted native
hook fields. Codex observations come from its native turn context/runtime records.
Readers are tied to the current launch and transcript, handle truncation and partial
records conservatively, and never read the terminal screen to guess state. A picker
change without a subsequent native record remains unobserved.

Shepherdr 2.1 launches Claude Code and Codex. Pi is a later addition. Remote logs and
hooks use the same core file/event interfaces as local agents, without an SSH log
mirror or daemon-proxy fallback. Native process liveness and explicit OSC status are
separate from task workflow: an idle or ended turn does not mean the task is Done.

The [acceptance record](core/implementation.md) names actual native versions, tested
status/restart cases and remaining provider/device limits. No hard token or money cap
is inferred from delayed native usage reports.
