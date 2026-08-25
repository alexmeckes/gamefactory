using UnityEngine;

namespace PullingSeason
{
    public sealed class PrototypeDisplay : MonoBehaviour
    {
        [SerializeField] private HarvestCrop crop;
        [SerializeField] private NextHarvestDecision nextDecision;

        private FirstPersonPullController player;
        private GUIStyle promptStyle;
        private Texture2D whiteTexture;
        private float startedAt;

        public void Configure(HarvestCrop targetCrop, NextHarvestDecision targetNextDecision)
        {
            crop = targetCrop;
            nextDecision = targetNextDecision;
        }

        private void Awake()
        {
            player = GetComponentInParent<FirstPersonPullController>();
            startedAt = Time.time;
            whiteTexture = new Texture2D(1, 1) { name = "FieldReadoutPixel" };
            whiteTexture.SetPixel(0, 0, Color.white);
            whiteTexture.Apply();
        }

        private void OnGUI()
        {
            if (crop == null) return;
            EnsureStyles();
            DrawReticle();

            var prompt = CurrentPrompt();
            if (string.IsNullOrEmpty(prompt)) return;

            var width = Mathf.Min(330f, Screen.width - 32f);
            var rect = new Rect((Screen.width - width) * 0.5f, Screen.height - 58f, width, 30f);
            DrawRect(rect, new Color(0.025f, 0.03f, 0.022f, 0.76f));
            GUI.Label(rect, prompt, promptStyle);
        }

        private void DrawReticle()
        {
            var center = new Vector2(Screen.width * 0.5f, Screen.height * 0.5f);
            var color = crop.RouteWarning
                ? new Color(1f, 0.24f, 0.08f, 0.94f)
                : (player != null && player.IsNearCrop
                    ? new Color(1f, 0.82f, 0.32f, 0.94f)
                    : new Color(0.96f, 0.94f, 0.76f, 0.78f));
            DrawRect(new Rect(center.x - 9f, center.y - 1f, 6f, 2f), color);
            DrawRect(new Rect(center.x + 3f, center.y - 1f, 6f, 2f), color);
            DrawRect(new Rect(center.x - 1f, center.y - 9f, 2f, 6f), color);
            DrawRect(new Rect(center.x - 1f, center.y + 3f, 2f, 6f), color);
        }

        private string CurrentPrompt()
        {
            if (crop.Acknowledged && nextDecision != null && nextDecision.DecisionAvailable) return string.Empty;
            if (crop.Harvested) return "SPACE  •  MARK THE HARVEST";
            if (crop.RouteWarning) return "SIDESTEP  •  UNWIND THE RED LINE";
            if (crop.GripActive) return string.Empty;
            if (player != null && player.IsNearCrop) return "HOLD LMB  •  TAKE THE STRAP";
            if (crop.GrowthStage == "Early" && Time.time - startedAt < 10f) return "RMB  •  LET IT GROW ONCE";
            return string.Empty;
        }

        private void EnsureStyles()
        {
            if (promptStyle != null) return;
            promptStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 14,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.98f, 0.94f, 0.78f) }
            };
        }

        private void DrawRect(Rect rect, Color color)
        {
            var previous = GUI.color;
            GUI.color = color;
            GUI.DrawTexture(rect, whiteTexture);
            GUI.color = previous;
        }
    }
}
