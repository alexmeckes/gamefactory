using UnityEngine;

namespace PullingSeason
{
    public sealed class PrototypeDisplay : MonoBehaviour
    {
        [SerializeField] private HarvestCrop crop;
        [SerializeField] private NextHarvestDecision nextDecision;
        [SerializeField] private TextMesh guidanceText;

        public void Configure(HarvestCrop targetCrop, NextHarvestDecision targetNextDecision, TextMesh targetGuidanceText)
        {
            crop = targetCrop;
            nextDecision = targetNextDecision;
            guidanceText = targetGuidanceText;
        }

        private void LateUpdate()
        {
            if (crop == null) return;

            if (guidanceText == null) return;

            var harmed = crop.Condition.Contains("slip") || crop.Condition.Contains("strain") || crop.Condition.Contains("bruis");
            guidanceText.color = harmed ? new Color(1f, 0.58f, 0.38f) : new Color(0.90f, 0.96f, 0.78f);

            if (crop.Acknowledged && nextDecision != null && nextDecision.DecisionAvailable)
                guidanceText.text = "RESULT CARRIED FORWARD  •  inspect the glowing next bed";
            else if (crop.Harvested)
                guidanceText.text = (harmed ? "BRUISED — lateral strain stayed visible" : "INTACT — straight tension released the root")
                    + "  •  SPACE acknowledge";
            else if (crop.Condition.Contains("slip"))
                guidanceText.text = "GRIP SLIPPED  •  E regrip  •  then A pull straight";
            else if (crop.GripActive)
                guidanceText.text = "GRIPPED  •  A pull straight  •  W/S loads the root sideways";
            else if (crop.GrowthStage == "Late")
                guidanceText.text = "LATE: broad crown + dry cracks  •  D approach  •  E grip";
            else
                guidanceText.text = "EARLY: small crown + loose seams  •  D approach  •  E grip  •  G grow once";
        }
    }
}
