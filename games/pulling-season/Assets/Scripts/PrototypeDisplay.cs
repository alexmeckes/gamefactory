using UnityEngine;

namespace PullingSeason
{
    public sealed class PrototypeDisplay : MonoBehaviour
    {
        [SerializeField] private HarvestCrop crop;
        [SerializeField] private NextHarvestDecision nextDecision;
        [SerializeField] private TextMesh guidanceText;
        [SerializeField] private Renderer guidancePanel;

        private static readonly Color NeutralPanel = new Color(0.035f, 0.055f, 0.05f);
        private static readonly Color LatePanel = new Color(0.16f, 0.075f, 0.025f);
        private static readonly Color HarmedPanel = new Color(0.19f, 0.035f, 0.025f);
        private static readonly Color DecisionPanel = new Color(0.055f, 0.13f, 0.055f);

        public void Configure(HarvestCrop targetCrop, NextHarvestDecision targetNextDecision,
            TextMesh targetGuidanceText, Renderer targetGuidancePanel)
        {
            crop = targetCrop;
            nextDecision = targetNextDecision;
            guidanceText = targetGuidanceText;
            guidancePanel = targetGuidancePanel;
        }

        private void LateUpdate()
        {
            if (crop == null) return;

            if (guidanceText == null) return;

            var harmed = crop.Condition.Contains("slip") || crop.Condition.Contains("strain") || crop.Condition.Contains("bruis");
            var decisionReady = crop.Acknowledged && nextDecision != null && nextDecision.DecisionAvailable;
            guidanceText.color = harmed
                ? new Color(1f, 0.72f, 0.50f)
                : (decisionReady ? new Color(0.88f, 1f, 0.63f) : Color.white);

            if (guidancePanel != null)
                guidancePanel.material.color = decisionReady
                    ? DecisionPanel
                    : (harmed ? HarmedPanel : (crop.GrowthStage == "Late" ? LatePanel : NeutralPanel));

            if (decisionReady)
                guidanceText.text = "NEXT BED READY  |  READ SOIL + CROWN";
            else if (crop.Harvested && crop.GripActive)
                guidanceText.text = harmed
                    ? "HELD + BRUISED  |  SPACE ACCEPT"
                    : "HELD  |  A/D STEADY  |  SPACE ACCEPT";
            else if (crop.Harvested)
                guidanceText.text = harmed
                    ? "BRUISED - SIDE LOAD  |  SPACE ACCEPT"
                    : "INTACT - STRAIGHT PULL  |  SPACE ACCEPT";
            else if (crop.Condition.Contains("slip"))
                guidanceText.text = "SLIPPED + BRUISED  |  E REGRIP  |  A PULL";
            else if (crop.GripActive)
                guidanceText.text = "GRIPPED  |  A PULL  |  W/S STRAINS";
            else if (crop.GrowthStage == "Late")
                guidanceText.text = "LATE: DRY + HEAVY  |  D THEN E";
            else
                guidanceText.text = "D APPROACH  |  E GRIP  |  G GROW";
        }
    }
}
