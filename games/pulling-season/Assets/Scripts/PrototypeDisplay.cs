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
                guidanceText.text = "NEXT BED READY  •  inspect the changed crop";
            else if (crop.Harvested && crop.GripActive)
                guidanceText.text = harmed
                    ? "HELD / BRUISED  •  SPACE accept"
                    : "HELD  •  A/D steady  •  W/S bruises  •  SPACE accept";
            else if (crop.Harvested)
                guidanceText.text = (harmed ? "BRUISED  •  sideways strain" : "INTACT  •  straight pull")
                    + "  •  E lift  •  SPACE accept";
            else if (crop.Condition.Contains("slip"))
                guidanceText.text = "SLIPPED / BRUISED  •  E regrip  •  A pull";
            else if (crop.GripActive)
                guidanceText.text = "GRIPPED  •  A pull  •  W/S strains";
            else if (crop.GrowthStage == "Late")
                guidanceText.text = "LATE / DRY ROOTS  •  D approach  •  E grip";
            else
                guidanceText.text = "EARLY / LOOSE SOIL  •  D approach  •  E grip  •  G grow";
        }
    }
}
