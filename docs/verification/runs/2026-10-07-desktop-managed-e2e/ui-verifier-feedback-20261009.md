# Independent UI verifier feedback — false green cases

Confirmed on source in phase02-client-review-repo, baseline2a49525, dirtycandidate,
verified bundledNode24.19.0. Harness filehashes captured separately from product
sourcehashes because the current sourceFingerprint only records productfiles.
No implementation fix is claimed; Claude remains primary and quota is unchanged.

## Empty selected claimset

Command: absolute bundlednode `tests/lumi-ui-proof/run.mjs --only=nonexistent-proof-prefix`.
Supervisor toolsession73880 terminalexit0. Report12-43-08 shows counts={} and
results=[]; browser/servercleanup succeeds. This is a falsegreen for missingproof.
Reject unknown/emptyselection before launch, or exitnonzero on zeroexecutedclaims.
A targeted subset must record its subsetscope; it cannot certify the wholeUIgate.
Regression must prove this exact reproducer exitsnonzero with a specificmissingclaims
diagnostic, while a realselectedclaim still executes normally.

## Sensitivity ignores childfailure

Command: absolute bundlednode `tests/lumi-ui-proof/sensitivity.mjs reread-keeps-projection`.
Supervisor toolsession26060 terminalexit0, outputDETECTED and1/1mutantsdetected.
Child report12-42-45 has expectedtwoFAILs, but cleanup.json says completefalse:
browser.close timedout10002ms, server.close succeeds. The childrunnerexplicitly
exits3 on incompletecleanup. Parent onlysearchesstdoutDETECTED and ignores
spawnSync status/signal/error and cleanup; it therefore promotes incompletecleanup
to a green campaign. Expectedred guardfailures are real, but the fullcampaign is
UNPROVEN. The storedparent row also omits its child'sexitstatus entirely.

Requiredrepair: accept a mutant only when expectedguardsFAIL, childexits0 with
no signal/error/timeout, reportexists/identifiersmatch and cleanupcomplete. Bound
spawnSync and clean ownedprocesses on timeout. Preserve these failures. Add a
regression that a child can emitDETECTED then failcleanup/exit3 and the parent
rejects it; buildcrash or missingreport must never count as detection.

## Remaining cleanup investigation

Clean fullactualsource56PASS is valid scopedReactfixture evidence; two failed
mutantclaims are intended. Browserclose repeatedlytimesout only during the
mutantcase; no verifiedrootcause yet. Do not forceexit0, disablecleanup or remove
mutantcoverage. All8mutants and cleanruntimeexit remain owed afterrepair.

Evidence files are prefixed20261009-ui-empty-claim and20261009-ui-sensitivity
in evidence/. FullgoalINCOMPLETE; no newPR, merge or productiondeployment.
