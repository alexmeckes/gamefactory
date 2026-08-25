using UnityEngine;

namespace PullingSeason
{
    public sealed class NextHarvestDecision : MonoBehaviour
    {
        public bool DecisionAvailable;

        [SerializeField] private Renderer cueRenderer;
        [SerializeField] private Material dormantMaterial;
        [SerializeField] private Material availableMaterial;
        [SerializeField] private GameObject cueBeacon;
        [SerializeField] private GameObject earlyLessonCue;
        [SerializeField] private GameObject lateLessonCue;
        [SerializeField] private GameObject damagedLessonCue;
        [SerializeField] private TextMesh decisionLabel;

        private Vector3 beaconRestScale;
        private Vector3 cueRestPosition;
        private Vector3 cueRestScale;
        private Quaternion cueRestRotation;
        private float revealClock;

        public void Configure(Renderer targetCueRenderer, Material targetDormantMaterial, Material targetAvailableMaterial,
            GameObject targetCueBeacon, GameObject targetEarlyLessonCue, GameObject targetLateLessonCue,
            GameObject targetDamagedLessonCue, TextMesh targetDecisionLabel)
        {
            cueRenderer = targetCueRenderer;
            dormantMaterial = targetDormantMaterial;
            availableMaterial = targetAvailableMaterial;
            cueBeacon = targetCueBeacon;
            earlyLessonCue = targetEarlyLessonCue;
            lateLessonCue = targetLateLessonCue;
            damagedLessonCue = targetDamagedLessonCue;
            decisionLabel = targetDecisionLabel;
        }

        private void Awake()
        {
            DecisionAvailable = false;
            SetCueActive(cueBeacon, false);
            SetCueActive(earlyLessonCue, false);
            SetCueActive(lateLessonCue, false);
            SetCueActive(damagedLessonCue, false);
            if (cueRenderer != null && dormantMaterial != null) cueRenderer.material = dormantMaterial;
            if (decisionLabel != null) decisionLabel.text = string.Empty;
            if (cueBeacon != null) beaconRestScale = cueBeacon.transform.localScale;
            if (cueRenderer != null)
            {
                cueRestPosition = cueRenderer.transform.localPosition;
                cueRestScale = cueRenderer.transform.localScale;
                cueRestRotation = cueRenderer.transform.localRotation;
            }
        }

        private void Update()
        {
            if (!DecisionAvailable) return;
            revealClock += Time.deltaTime;
            if (cueBeacon != null)
            {
                var pulse = 1f + Mathf.Sin(revealClock * 5.2f) * 0.14f;
                cueBeacon.transform.localScale = beaconRestScale * pulse;
                cueBeacon.transform.Rotate(0f, 70f * Time.deltaTime, 0f, Space.Self);
            }
            if (cueRenderer != null)
                cueRenderer.transform.localPosition = cueRestPosition + Vector3.up * (0.06f + Mathf.Sin(revealClock * 3.6f) * 0.04f);
        }

        public void Reveal(bool previousDamaged, string previousStage)
        {
            DecisionAvailable = true;
            SetCueActive(cueBeacon, true);
            SetCueActive(earlyLessonCue, !previousDamaged && previousStage == "Early");
            SetCueActive(lateLessonCue, !previousDamaged && previousStage == "Late");
            SetCueActive(damagedLessonCue, previousDamaged);

            var lessonColor = previousDamaged
                ? new Color(0.98f, 0.28f, 0.09f)
                : (previousStage == "Late" ? new Color(1f, 0.70f, 0.14f) : new Color(0.52f, 0.90f, 0.24f));
            if (cueRenderer != null)
            {
                if (availableMaterial != null) cueRenderer.material = availableMaterial;
                cueRenderer.material.color = lessonColor;
                cueRenderer.transform.localScale = Vector3.Scale(cueRestScale,
                    previousDamaged
                        ? new Vector3(0.82f, 0.70f, 0.82f)
                        : (previousStage == "Late"
                            ? new Vector3(1.22f, 1.16f, 1.22f)
                            : new Vector3(0.94f, 0.90f, 0.94f)));
                cueRenderer.transform.localRotation = cueRestRotation
                    * Quaternion.Euler(previousDamaged ? 0f : -5f, 0f, previousDamaged ? 18f : 0f);
            }
            if (cueBeacon != null)
            {
                var beaconRenderer = cueBeacon.GetComponent<Renderer>();
                if (beaconRenderer != null) beaconRenderer.material.color = lessonColor;
                beaconRestScale *= previousDamaged ? 1.28f : 1f;
            }

            if (decisionLabel != null)
            {
                decisionLabel.text = previousDamaged
                    ? "FOLLOW THE OPEN SEAM"
                    : (previousStage == "Late" ? "DENSE ROOTS / CLEAN LINE" : "SMALL NOW / LARGER LATER");
                decisionLabel.color = new Color(1f, 0.92f, 0.52f);
            }
        }

        private static void SetCueActive(GameObject cue, bool active)
        {
            if (cue != null) cue.SetActive(active);
        }
    }
}
