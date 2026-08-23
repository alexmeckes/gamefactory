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
