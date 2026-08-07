import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_context_service.mjs"
CANARY = ROOT / "scripts" / "run_pi_context_canary.mjs"
ADJUDICATOR = ROOT / "scripts" / "adjudicate_pi_context_canary.mjs"
BEHAVIORAL_MANIFEST = ROOT / "tests" / "fixtures" / "pi_context" / "live_behavioral_canary_acceptance.json"


def test_active_context_service_is_pageable_reversible_and_native_safe():
    result = subprocess.run(
        ["node", str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["durableGuidanceObligation"] is True
    assert report["guidanceDeliveryBeforeProjection"] is True
    assert report["identicalGuidanceHookEveryRequest"] is True
    assert report["changingEphemeralSuggestion"] is True
    assert report["guidanceLifecyclePersistence"] is True
    assert report["guidanceExactActionClosure"] is True
    assert report["guidanceReductionValidated"] is True
    assert report["guidanceFallbackRemediation"] is True
    assert report["guidanceAmbiguityRejected"] is True
    assert report["mixedProtocolActionDeduplication"] is True
    assert report["deferredProviderConfirmationPrecedesFold"] is True
    assert report["deferredConfirmationSurvivesAttributionChange"] is True
    assert report["crossModelGuidanceClosure"] is True
    assert report["durableActionDriftDoesNotResurrect"] is True
    assert report["providerCallbackCapCannotBeBypassed"] is True
    assert report["resolvedCallbackAuthoritiesRetire"] is True
    assert report["guidanceDeliveryFailureLoud"] is True
    assert report["guidanceConcurrentDeliveryDeduplicated"] is True
    assert report["historicalGuidanceReceiptsReadable"] is True
    assert report["guidanceDeliveryContainsNoProse"] is True
    assert report["guidanceNoUnactedCloseOrRearm"] is True
    assert report["guidanceStatusBoundedIdentity"] is True
    assert report["guidancePendingReductionReloadSafe"] is True
    assert report["guidanceOneToOneCausality"] is True
    assert report["directInvocationCannotCloseGuidance"] is True
    assert report["automaticFallbackCannotCloseGuidance"] is True
    assert report["nonReductionCannotCloseGuidance"] is True
    assert report["reusedDeliveryOrReductionRejected"] is True
    assert report["pressureJumpDoesNotBypassGuidance"] is True
    assert report["unboundedRequestBlockingAbsent"] is True
    assert report["finalRungContextAwaitsPreparation"] is True
    assert report["concurrentContextAuthoritySerialized"] is True
    assert report["revisionZeroMeasurementRequiresReceipt"] is True
    assert report["sameSessionLifecycleSerialized"] is True
    assert report["hardFenceAbortsRawProviderRequest"] is True
    assert report["activeContextRegistrationEnabled"] is True
    assert report["nativeCompactionFailSafe"] is False
    assert report["zeroNativeCompactionGoal"] is True
    assert report["completedMutationChapterEligible"] is True
    assert report["inFlightMutationChapterEligible"] is True
    assert report["currentMarathonObjectiveProtected"] is True
    assert report["immediateManualPersistence"] is True
    assert report["messageEndChapterCommit"] is True
    assert report["unmatchedMutationStayedRaw"] is True
    assert report["oversizedTurnSegmentedAtToolBatch"] is True
    assert report["userRescueCommand"] is True
    assert report["stockThresholdCompactionBlocked"] is True
    assert report["historicalNativeReceiptParsing"] is True
    assert report["explicitNativeFallbackDecision"] is False
    assert report["providerReportedPressureOnly"] is True
    assert report["projectionMeasurementInvalidation"] is True
    assert report["projectionMeasurementRestartSafe"] is True
    assert report["revisionZeroMeasurementRequiresReceipt"] is True
    assert report["concurrentContextMeasurementBarrier"] is True
    assert report["contextCallbacksSerialized"] is True
    assert report["providerModelAttribution"] is True
    assert report["fourChaptersConsolidated"] is False
    assert report["fiveChaptersConsolidated"] == 5
    assert report["nestedToolLeaf"].startswith("fold_")
    assert len(report["recursiveRecoverySha256"]) == 64
    assert len(report["orderedRoots"]) == 2
    assert report["boundedStatusPaging"] is True
    assert report["contextDiagnostics"] is True
    assert report["missingBriefLunaCalls"] == 1
    assert report["suppliedBriefLunaCalls"] == 0
    assert report["orientationExcluded"] is True
    assert report["currentCollapsedProjectionCandidates"] is True
    assert set(report["preparedDriftDiscards"]) == {
        "branch", "generation", "source", "orientation", "protection", "freshTail", "topology",
    }
    assert report["malformedUsagePassThrough"] is True
    assert report["skippedProviderErrorMapped"] is True
    assert report["sameTurnManualProjection"] is True
    assert report["sameTurnProtection"] is True
    assert report["turnBoundaryIndependentPersistence"] is True
    assert report["automaticToolBoundaryCommit"] is True
    assert report["automaticToolBatchFolds"] == 1
    assert report["automaticCrossBatchBacklogPreempted"] is True
    assert 0 < report["hierarchicalProjectedSourceBytes"] < 20_000
    assert report["nestedChildDriftRejected"] is True
    assert report["automaticChapterAfterBacklog"] is True
    assert report["inFlightPreparationStable"] is True
    assert report["automaticStaleRefold"] is True
    assert report["postOverflowNativeSafetyNet"] is False
    assert report["extensionProjectionNeverRetriesOverflow"] is True
    assert report["defensiveOverflowBlocked"] is True
    assert report["completedOverflowBlocked"] is True
    assert report["irreducibleOverflowBlocked"] is True
    assert report["compactionCallbackDoesNotControlPreparation"] is True
    assert report["boundedBriefDeadline"] is True
    assert report["fallbackLunaRevalidated"] is True
    assert report["subagentAbortSettlesLocally"] is True
    assert report["consumedMidturnToolBatch"] is True
    assert report["customTimestampAlignment"] is True
    assert report["thresholdHandledCheckpointFree"] is True
    assert report["oversizedBriefBounded"] is True
    assert report["authoritativeEventOnly"] is True
    assert report["recursiveConsolidation"] is True
    assert report["deterministicAutomaticConsolidation"] is True
    assert report["expandedChildrenPreserved"] is True
    assert report["currentPressureReselection"] is True
    assert all(report["terminalChecks"].values())
    assert all(report["exactStateKeys"].values())
    assert report["structuralBriefRejected"] is True
    assert report["utf8RenderedCosts"] is True
    assert all(report["toolBatchValidation"].values())
    assert report["atomicParallelToolBatch"] is True
    assert all(report["boundaryFailureLoud"].values())
    assert report["exactPackageService"] is True
    assert all(report["mutablePrototypeSafe"].values())
    assert report["automaticTriggerFeedback"] is True
    assert report["userRescueNotAgentAttributed"] is True
    assert report["offBranchProviderCannotAuthorize"] is True
    assert report["providerConfirmationAfterPersistence"] is True
    assert report["duplicateProviderCallbacksCannotReauthorize"] is True
    assert report["staleDeferredContextIsInert"] is True
    assert report["staleProviderMeasurementsIgnored"] is True
    assert report["successfulProviderResponsesOnly"] is True
    assert report["oldGovernorAbsent"] is True


def test_canary_calibration_manifest_is_self_contained():
    env = os.environ.copy()
    env["QUORUM_CANARY_DRY_RUN"] = "1"
    env["QUORUM_CANARY_CALIBRATION_MANIFEST_ONLY"] = "1"
    result = subprocess.run(
        ["node", str(CANARY)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["preflightOnly"] is True
    assert report["behavioralMode"] == "extension-guidance-only-blind-workload"
    assert report["workload"]["hiddenCriteriaTermsAbsent"] is True
    assert len(report["workload"]["promptSha256"]) == 64
    assert len(report["workload"]["visibleCorpusSha256"]) == 64
    assert report["workload"]["seedMessages"] == 6
    assert report["workload"]["evidenceFiles"] == 30
    assert report["workload"]["behaviorPromptSource"] == "runtime-extension-guidance-only"
    assert report["calibration"]["evidenceSource"] == "committed-derived-manifest"
    assert report["calibration"]["reportSha256"] == (
        "4047bbbdfffc44f235b7c2c518e7dc71a84fd370494891ed569ff317b8f5ffab"
    )
    assert report["calibration"]["sessionSha256"] == (
        "fb5525809d0b4455580e4992e49976d9a632c4a356fd2a97ed97c3ea787f9517"
    )
    assert report["chain"]["files"] == 30
    assert report["chain"]["calibratedPrefixFiles"] == 17
    assert report["chain"]["adaptiveStopTokens"] == 136_000
    assert report["chain"]["automaticAbortTokens"] == 204_000
    assert report["chain"]["adaptiveProbe"]["file"] == 17
    assert report["chain"]["adaptiveProbe"]["bytes"] == 30_000
    assert report["chain"]["adaptiveProbe"]["next"] == "END"
    assert report["calibration"]["projectedCheckpoints"] == 70
    assert report["calibration"]["projectedNoFoldFinalTokens"] == 241_465
    assert report["calibration"]["projectedAfterTwoSmallFolds"] == 233_379
    assert report["prefixCalibration"]["evidenceSource"] == "committed-derived-manifest"
    assert report["prefixCalibration"]["reportSha256"] == (
        "8548b58e04670259fcfb824b75c491317c6dce63da4817af4ad5999be1bbf018"
    )
    assert report["prefixCalibration"]["sessionSha256"] == (
        "bba69543f4a40896582b08fd3fa8836944fde063c76ed60743279884544812a7"
    )
    assert report["prefixCalibration"]["targetChainFiles"] == 17
    assert report["prefixCalibration"]["projectedHighWaterTokens"] == 199_179
    assert 190_400 <= report["prefixCalibration"]["projectedHighWaterTokens"] < 204_000
    assert report["prefixCalibration"]["firstExcluded"]["tokens"] == 206_048
    assert report["prefixCalibration"]["headroomTokens"] == 4_821


def test_live_behavioral_canary_manifest_is_self_contained():
    payload = BEHAVIORAL_MANIFEST.read_bytes()
    assert hashlib.sha256(payload).hexdigest() == (
        "6df3a3306c48eb759548d2587146e90b9a11b3067a70fe60c79151695fb8a0f2"
    )
    manifest = json.loads(payload)
    assert set(manifest) == {
        "version", "source", "workload", "policy", "observed", "causalFolds", "independentRecovery"
    }
    assert manifest["version"] == 1
    assert manifest["source"]["codeCommit"] == "d11d060e3b3090fcaaa9d2902d765d6c9e477d51"
    assert manifest["source"]["reportSha256"] == (
        "9d4405733d49b47feb25195cf7f665c22f1918544c3f76715ebfaffe141b784e"
    )
    assert manifest["source"]["sessionSha256"] == (
        "9c412ba511ec586518b157b99f22a562e6bdd81b0cd2b19dc02b206647fdb87e"
    )
    assert manifest["workload"]["hiddenCriteriaTermsAbsent"] is True
    assert manifest["workload"]["behaviorPromptSource"] == "runtime-extension-guidance-only"
    assert manifest["workload"]["seedMessages"] == 6
    assert manifest["workload"]["evidenceFiles"] == 30
    assert manifest["policy"] == {
        "automaticToolTokens": 204_000,
        "behavioralMode": "extension-guidance-only-blind-workload",
        "contextWindow": 272_000,
        "requiredAgentFolds": 2,
        "stockAutomaticCompactionEnabled": False,
    }
    observed = manifest["observed"]
    assert observed["highWaterTokens"] == 184_771 < manifest["policy"]["automaticToolTokens"]
    assert observed["foldCalls"] == observed["guidanceActions"] == 2
    assert observed["automaticFallbacks"] == 0
    assert observed["nativeCompactions"] == observed["nativeDecisions"] == observed["nativeReceipts"] == 0
    assert observed["compactionEvents"] == 0
    assert observed["terminalStopReason"] == "stop"
    folds = manifest["causalFolds"]
    assert len(folds) == 2
    assert len({item["projectionRevision"] for item in folds}) == len(folds)
    assert len({item["afterMeasurementSha256"] for item in folds}) == len(folds)
    assert all(item["afterTokens"] < item["beforeTokens"] for item in folds)
    recovery = {item["foldId"]: item for item in manifest["independentRecovery"]}
    assert all(recovery[item["foldId"]]["recoveredSha256"] == item["recoveredSha256"] for item in folds)


def test_canary_acceptance_candidate_manifest_is_self_contained():
    env = os.environ.copy()
    env["QUORUM_CANARY_ACCEPTANCE_MANIFEST_ONLY"] = "1"
    result = subprocess.run(
        ["node", str(ADJUDICATOR)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["acceptance"] is False
    assert report["preflightOnly"] is True
    assert report["manifestSha256"] == (
        "7ca5e1423071cab3a19ca97d969df26421ef96d703d6f0ed1e911a2b78167fbc"
    )
    assert report["source"]["reportSha256"] == (
        "0c6594b13c7b46bc68d7682e62049b7cc520ca55c9a2c692b00416811a2f6c84"
    )
    assert report["source"]["sessionSha256"] == (
        "16be121de20dda1d3627c6b8f75ce74963f420d84babeaeb253705261829444e"
    )
    assert report["policy"]["requiredAgentFolds"] == 2
    assert report["observed"]["guidanceActions"] == 5
    assert report["observed"]["highWaterTokens"] == 145_250
