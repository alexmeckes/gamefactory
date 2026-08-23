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
        [SerializeField] private TextMesh decisionLabel;

        private Vector3 beaconRestScale;
        private Vector3 cueRestPosition;
        private float revealClock;

        public void Configure(Renderer targetCueRenderer, Material targetDormantMaterial, Material targetAvailableMaterial,
            GameObject targetCueBeacon, TextMesh targetDecisionLabel)
        {
            cueRenderer = targetCueRenderer;
            dormantMaterial = targetDormantMaterial;
            availableMaterial = targetAvailableMaterial;
            cueBeacon = targetCueBeacon;
            decisionLabel = targetDecisionLabel;
        }

        private void Awake()
        {
            DecisionAvailable = false;
            if (cueBeacon != null) cueBeacon.SetActive(false);
            if (cueRenderer != null && dormantMaterial != null) cueRenderer.material = dormantMaterial;
            if (decisionLabel != null) decisionLabel.text = "NEXT BED\nObserve after harvest";
            if (cueBeacon != null) beaconRestScale = cueBeacon.transform.localScale;
            if (cueRenderer != null) cueRestPosition = cueRenderer.transform.localPosition;
        }

        private void Update()
        {
            if (!DecisionAvailable) return;
            revealClock += Time.deltaTime;
            if (cueBeacon != null)
            {
                var pulse = 1f + Mathf.Sin(revealClock * 6f) * 0.18f;
                cueBeacon.transform.localScale = beaconRestScale * pulse;
                cueBeacon.transform.Rotate(0f, 90f * Time.deltaTime, 0f, Space.Self);
            }
            if (cueRenderer != null)
                cueRenderer.transform.localPosition = cueRestPosition + Vector3.up * (0.07f + Mathf.Sin(revealClock * 4f) * 0.05f);
        }

        public void Reveal(bool previousDamaged, string previousStage)
        {
            DecisionAvailable = true;
            if (cueBeacon != null) cueBeacon.SetActive(true);
            if (cueRenderer != null && availableMaterial != null) cueRenderer.material = availableMaterial;
            if (decisionLabel != null)
            {
                decisionLabel.text = previousDamaged
                    ? "NEXT DECISION\nWet soil + shallow crown\nPull straight, or wait?"
                    : (previousStage == "Late"
                        ? "NEXT DECISION\nDry cracks + broad crown\nTake early, or risk weight?"
                        : "NEXT DECISION\nFirm soil + small crown\nTake safe, or grow once?");
                decisionLabel.color = new Color(1f, 0.92f, 0.52f);
            }
        }
    }
}
