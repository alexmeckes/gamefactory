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
        private Vector3 cueRestScale;
        private Quaternion cueRestRotation;
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
            if (decisionLabel != null) decisionLabel.text = "NEXT HARVEST\nOBSERVE AFTER THIS PULL";
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
            var lessonColor = previousDamaged
                ? new Color(0.95f, 0.26f, 0.10f)
                : (previousStage == "Late" ? new Color(1f, 0.72f, 0.16f) : new Color(0.56f, 0.88f, 0.20f));
            if (cueRenderer != null)
            {
                if (availableMaterial != null) cueRenderer.material = availableMaterial;
                cueRenderer.material.color = lessonColor;
                cueRenderer.transform.localScale = Vector3.Scale(cueRestScale,
                    previousDamaged
                        ? new Vector3(0.82f, 0.72f, 0.82f)
                        : (previousStage == "Late"
                            ? new Vector3(1.20f, 1.12f, 1.20f)
                            : new Vector3(0.94f, 0.90f, 0.94f)));
                cueRenderer.transform.localRotation = cueRestRotation
                    * Quaternion.Euler(previousDamaged ? 0f : -5f, 0f, previousDamaged ? 18f : 0f);
            }
            if (cueBeacon != null)
            {
                var beaconRenderer = cueBeacon.GetComponent<Renderer>();
                if (beaconRenderer != null) beaconRenderer.material.color = lessonColor;
                cueBeacon.transform.localScale = beaconRestScale * (previousDamaged ? 1.35f : 1f);
                beaconRestScale = cueBeacon.transform.localScale;
            }
            if (decisionLabel != null)
            {
                decisionLabel.text = previousDamaged
                    ? "NEXT HARVEST\nWET SOIL + SHALLOW CROWN\nPULL STRAIGHT / WAIT"
                    : (previousStage == "Late"
                        ? "NEXT HARVEST\nDRY CRACKS + BROAD CROWN\nTAKE EARLY / RISK WEIGHT"
                        : "NEXT HARVEST\nFIRM SOIL + SMALL CROWN\nTAKE SAFE / GROW ONCE");
                decisionLabel.color = new Color(1f, 0.92f, 0.52f);
            }
        }
    }
}
