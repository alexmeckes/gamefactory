using UnityEngine;

namespace PullingSeason
{
    public sealed class PrototypeDisplay : MonoBehaviour
    {
        [SerializeField] private HarvestCrop crop;
        [SerializeField] private NextHarvestDecision nextDecision;
        [SerializeField] private TextMesh cueText;
        [SerializeField] private TextMesh statusText;
        [SerializeField] private TextMesh controlText;
        [SerializeField] private Transform progressFill;
        [SerializeField] private Renderer progressRenderer;
        [SerializeField] private Material earlyProgress;
        [SerializeField] private Material lateProgress;
        [SerializeField] private Material damagedProgress;

        public void Configure(HarvestCrop targetCrop, NextHarvestDecision targetNextDecision, TextMesh targetCueText,
            TextMesh targetStatusText, TextMesh targetControlText, Transform targetProgressFill, Renderer targetProgressRenderer,
            Material targetEarlyProgress, Material targetLateProgress, Material targetDamagedProgress)
        {
            crop = targetCrop;
            nextDecision = targetNextDecision;
            cueText = targetCueText;
            statusText = targetStatusText;
            controlText = targetControlText;
            progressFill = targetProgressFill;
            progressRenderer = targetProgressRenderer;
            earlyProgress = targetEarlyProgress;
            lateProgress = targetLateProgress;
            damagedProgress = targetDamagedProgress;
        }

        private void LateUpdate()
        {
            if (crop == null) return;

            if (cueText != null)
            {
                var wager = crop.GrowthStage == "Late"
                    ? "PLAN: LATE / larger + resistant"
                    : "PLAN: EARLY / smaller + safer\nG: risk one visible growth step";
                cueText.text = "READ THE BED\nCROWN: " + (crop.GrowthStage == "Late" ? "broad / amber" : "small / green")
                    + "\nSOIL: " + (crop.GrowthStage == "Late" ? "dry cracks / dense" : "pale seams / loose")
                    + "\n" + wager;
            }

            if (statusText != null)
            {
                statusText.text = crop.Harvested
                    ? crop.Condition + "\nCrop remains physical" + (crop.Acknowledged ? "\nNEXT BED OPEN" : "\nSPACE: acknowledge result")
                    : crop.Condition + "\nPULL " + Mathf.RoundToInt(crop.PullProgress * 100f) + "%";
                statusText.color = crop.Condition.Contains("slip") || crop.Condition.Contains("strain") || crop.Condition.Contains("bruis")
                    ? new Color(1f, 0.48f, 0.34f)
                    : new Color(0.82f, 1f, 0.72f);
            }

            if (controlText != null)
                controlText.text = crop.Harvested
                    ? (crop.Acknowledged ? "Lesson carried forward: choose the next plan" : "SPACE  ACKNOWLEDGE THE PHYSICAL RESULT")
                    : (crop.GripActive
                        ? "TETHERED: MOVEMENT DOES THE WORK     A  PULL STRAIGHT\nW/S  LOAD SIDEWAYS     E  ONLY REGRIPS"
                        : "D  APPROACH     E  GRIP / REGRIP     A  PULL AWAY\nW/S  CHANGE ANGLE     G  COMMIT LATE");

            if (progressFill != null)
            {
                var width = Mathf.Max(0.02f, crop.PullProgress);
                progressFill.localScale = new Vector3(width, 1f, 1f);
                progressFill.localPosition = new Vector3(-0.49f + width * 0.49f, progressFill.localPosition.y, progressFill.localPosition.z);
            }

            if (progressRenderer != null)
            {
                var material = crop.Condition.Contains("slip") || crop.Condition.Contains("strain") || crop.Condition.Contains("bruis")
                    ? damagedProgress
                    : (crop.GrowthStage == "Late" ? lateProgress : earlyProgress);
                if (material != null && progressRenderer.sharedMaterial != material) progressRenderer.sharedMaterial = material;
            }
        }
    }
}
