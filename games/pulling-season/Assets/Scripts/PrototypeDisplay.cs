using UnityEngine;

namespace PullingSeason
{
    public sealed class PrototypeDisplay : MonoBehaviour
    {
        [SerializeField] private HarvestCrop crop;
        [SerializeField] private NextHarvestDecision nextDecision;
        private FirstPersonPullController player;
        private GUIStyle promptStyle;
        private GUIStyle hintStyle;
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
            whiteTexture = new Texture2D(1, 1);
            whiteTexture.SetPixel(0, 0, Color.white);
            whiteTexture.Apply();
        }

        private void OnGUI()
        {
            if (crop == null) return;
            EnsureStyles();

            DrawRect(new Rect(Screen.width * 0.5f - 2f, Screen.height * 0.5f - 2f, 4f, 4f), new Color(1f, 0.92f, 0.62f, 0.9f));

            var prompt = CurrentPrompt();
            if (!string.IsNullOrEmpty(prompt))
            {
                var width = Mathf.Min(430f, Screen.width - 32f);
                var rect = new Rect((Screen.width - width) * 0.5f, Screen.height - 66f, width, 36f);
                DrawRect(rect, new Color(0.025f, 0.035f, 0.028f, 0.82f));
                GUI.Label(rect, prompt, promptStyle);
            }

            if (crop.GripActive && !crop.Harvested)
            {
                var bar = new Rect(Screen.width * 0.5f - 90f, Screen.height - 87f, 180f, 7f);
                DrawRect(bar, new Color(0f, 0f, 0f, 0.55f));
                var color = crop.Tension01 > 0.82f ? new Color(0.95f, 0.25f, 0.12f) : new Color(0.88f, 0.72f, 0.22f);
                DrawRect(new Rect(bar.x + 1f, bar.y + 1f, (bar.width - 2f) * crop.Tension01, bar.height - 2f), color);
            }

            if (Time.time - startedAt < 4.5f)
                GUI.Label(new Rect(18f, Screen.height - 42f, 260f, 24f), "WASD move  ·  mouse look", hintStyle);
        }

        private string CurrentPrompt()
        {
            if (crop.Acknowledged && nextDecision != null && nextDecision.DecisionAvailable) return "Another bed is ready";
            if (crop.Harvested) return crop.Damaged ? "Bruised  ·  Space to finish" : "Clean harvest  ·  Space to finish";
            if (crop.GripActive) return crop.Damaged ? "Ease off and pull straight" : "Pull backward — keep the stem centered";
            if (player != null && player.IsNearCrop) return "Hold left mouse to grip";
            return string.Empty;
        }

        private void EnsureStyles()
        {
            if (promptStyle != null) return;
            promptStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 17,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.96f, 0.94f, 0.82f) }
            };
            hintStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 13,
                normal = { textColor = new Color(1f, 1f, 1f, 0.72f) }
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
