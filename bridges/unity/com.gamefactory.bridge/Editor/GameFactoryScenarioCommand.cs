using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.SceneManagement;

namespace GameFactory.UnityBridge
{
    public static class GameFactoryScenarioCommand
    {
        private const string ScenarioApi = "gamefactory.unity-scenario/v1";
        private const string TraceApi = "gamefactory.embodied-trace/v1";
        private const string Producer = "factory-owned-unity-bridge";
        private static bool running;

        [CliCommand("gamefactory_prepare_playmode", "Prepare a domain-reload-safe GameFactory evidence run", MainThreadRequired = true)]
        public static string PreparePlayMode(
            [CliArg("state", "Absolute path used to preserve the prior Editor play-mode settings")] string state)
        {
            if (string.IsNullOrWhiteSpace(state) || !Path.IsPathRooted(state))
                throw new InvalidDataException("The play-mode settings state path must be absolute.");
            var previous = new PlayModeSettings
            {
                enabled = EditorSettings.enterPlayModeOptionsEnabled,
                options = (int)EditorSettings.enterPlayModeOptions
            };
            Directory.CreateDirectory(Path.GetDirectoryName(state) ?? ".");
            File.WriteAllText(state, JsonUtility.ToJson(previous, true));
            EditorSettings.enterPlayModeOptionsEnabled = true;
            EditorSettings.enterPlayModeOptions = EditorSettings.enterPlayModeOptions | EnterPlayModeOptions.DisableDomainReload;
            AssetDatabase.SaveAssets();
            return "GameFactory play-mode evidence preparation completed.";
        }

        [CliCommand("gamefactory_run_scenario", "Run a deterministic GameFactory scenario and preserve trusted runtime evidence", MainThreadRequired = true)]
        public static async Task<string> RunScenario(
            [CliArg("request", "Absolute path to the factory-owned scenario request JSON")] string request,
            [CliArg("output", "Absolute path for the scenario result JSON")] string output)
        {
            if (running) throw new InvalidOperationException("A GameFactory scenario is already running.");
            running = true;
            var pressedControls = new List<InputControl>();
            PlayModeSettings previous = null;
            try
            {
                var envelope = ReadJson<RequestEnvelope>(request, "request");
                previous = ReadJson<PlayModeSettings>(envelope.playModeStatePath, "play-mode settings state");
                if (!EditorSettings.enterPlayModeOptionsEnabled || (EditorSettings.enterPlayModeOptions & EnterPlayModeOptions.DisableDomainReload) == 0)
                    throw new InvalidOperationException("Run gamefactory_prepare_playmode before the scenario command.");
                var contract = ReadJson<ScenarioContract>(envelope.scenarioPath, "scenario contract");
                Validate(envelope, contract, output);
                Directory.CreateDirectory(envelope.outputDirectory);
                EditorSceneManager.OpenScene(contract.scenePath, OpenSceneMode.Single);
                await EnterPlayMode();
                var result = await Execute(envelope, contract, pressedControls);
                File.WriteAllText(output, JsonUtility.ToJson(result, true));
                return $"GameFactory scenario {contract.id} completed with status {result.status}.";
            }
            catch (Exception error)
            {
                var failure = new ScenarioResult
                {
                    apiVersion = "gamefactory.unity-scenario-result/v1",
                    status = "crash",
                    violations = new List<Violation> { new Violation { code = "unity.bridge.exception", message = error.ToString(), severity = "error" } }
                };
                Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");
                File.WriteAllText(output, JsonUtility.ToJson(failure, true));
                throw;
            }
            finally
            {
                foreach (var control in pressedControls)
                {
                    try { QueueControlValue(control, 0f); } catch { }
                }
                if (EditorApplication.isPlaying) await ExitPlayMode();
                if (previous != null)
                {
                    EditorSettings.enterPlayModeOptions = (EnterPlayModeOptions)previous.options;
                    EditorSettings.enterPlayModeOptionsEnabled = previous.enabled;
                    AssetDatabase.SaveAssets();
                }
                running = false;
            }
        }

        private static async Task<ScenarioResult> Execute(RequestEnvelope envelope, ScenarioContract contract, List<InputControl> pressedControls)
        {
            var trace = new EmbodiedTrace { apiVersion = TraceApi, producer = Producer };
            var artifacts = new List<Artifact>();
            var violations = new List<Violation>();
            var previousStates = ObserveStates(contract.stateObservations);
            var frameIndex = 0;
            var captureIndex = 0;
            await NextUpdate();
            Capture(contract, envelope.outputDirectory, trace, artifacts, null, new List<TraceEvent>(), ref captureIndex);

            foreach (var step in contract.steps)
            {
                var control = InputSystem.FindControl(step.control);
                if (control == null) throw new InvalidOperationException($"Shipping Input System control is unavailable: {step.control}");
                var value = step.pressed ? (Math.Abs(step.value) > float.Epsilon ? step.value : 1f) : 0f;
                QueueControlValue(control, value);
                if (step.pressed && !pressedControls.Contains(control)) pressedControls.Add(control);
                if (!step.pressed) pressedControls.Remove(control);
                var input = new TraceInput { delivery = "unity-input-system", kind = "control", control = step.control, pressed = step.pressed, value = value };
                var frames = Math.Max(1, step.frames);
                for (var frame = 0; frame < frames; frame++)
                {
                    await NextUpdate();
                    frameIndex++;
                    if (contract.captureEveryFrames > 0 && frameIndex % contract.captureEveryFrames == 0)
                        Capture(contract, envelope.outputDirectory, trace, artifacts, input, new List<TraceEvent>(), ref captureIndex);
                }

                var latency = 0;
                var nextStates = ObserveStates(contract.stateObservations);
                while (latency < Math.Max(0, step.settleFrames) && !Changed(previousStates, nextStates))
                {
                    await NextUpdate();
                    latency++;
                    frameIndex++;
                    nextStates = ObserveStates(contract.stateObservations);
                }
                var events = StateEvents(contract.stateObservations, previousStates, nextStates, latency);
                if (step.interaction)
                {
                    var actor = FindRequired(contract.actorPath, "actor");
                    var target = FindRequired(contract.targetPath, "target");
                    var distance = Vector3.Distance(actor.transform.position, target.transform.position);
                    events.Add(new TraceEvent
                    {
                        kind = "spatial-interaction",
                        targetId = contract.targetPath,
                        distance = distance,
                        range = contract.interactionRange,
                        outcome = distance <= contract.interactionRange && events.Exists(item => item.kind == "state-change") ? "applied" : "not-applied",
                        cause = "player-input",
                        latencyFrames = latency
                    });
                }
                Capture(contract, envelope.outputDirectory, trace, artifacts, input, events, ref captureIndex);
                previousStates = nextStates;
            }

            var tracePath = Path.Combine(envelope.outputDirectory, "embodied-trace.json");
            File.WriteAllText(tracePath, JsonUtility.ToJson(trace, true));
            artifacts.Add(new Artifact
            {
                kind = "replay",
                path = tracePath,
                mediaType = "application/json",
                label = "Unity embodied gameplay trace",
                metadata = new ArtifactMetadata { producer = Producer, protocol = TraceApi, evidenceRole = "interaction-trace" }
            });
            if (trace.samples.Count < 2) violations.Add(new Violation { code = "unity.bridge.samples", message = "Scenario produced fewer than two samples.", severity = "error" });
            return new ScenarioResult
            {
                apiVersion = "gamefactory.unity-scenario-result/v1",
                status = violations.Count == 0 ? "pass" : "fail",
                metrics = new ScenarioMetrics { unity_scenario_frames = frameIndex, unity_scenario_captures = captureIndex },
                artifacts = artifacts,
                violations = violations,
                metadata = new ResultMetadata { producer = Producer, scenarioId = contract.id }
            };
        }

        private static void QueueControlValue(InputControl control, float value)
        {
            if (control is KeyControl key)
            {
                var state = value > 0.5f ? new KeyboardState(key.keyCode) : new KeyboardState();
                InputSystem.QueueStateEvent(key.device, state);
                return;
            }

            if (control is ButtonControl button)
            {
                InputSystem.QueueDeltaStateEvent(button, value);
                return;
            }

            if (control is AxisControl axis)
            {
                InputSystem.QueueDeltaStateEvent(axis, value);
                return;
            }

            throw new InvalidOperationException($"Unsupported shipping input control '{control.path}'. Expected a button or axis control.");
        }

        private static void Capture(ScenarioContract contract, string outputDirectory, EmbodiedTrace trace, List<Artifact> artifacts, TraceInput input, List<TraceEvent> events, ref int captureIndex)
        {
            var actor = FindRequired(contract.actorPath, "actor");
            var framePath = Path.Combine(outputDirectory, $"frame-{captureIndex:D4}.png");
            var bytes = RenderFrame(Math.Max(64, contract.captureWidth), Math.Max(64, contract.captureHeight));
            File.WriteAllBytes(framePath, bytes);
            artifacts.Add(new Artifact
            {
                kind = "image",
                path = framePath,
                mediaType = "image/png",
                label = $"Unity runtime frame {captureIndex}",
                metadata = new ArtifactMetadata { producer = Producer, evidenceRole = "continuous-frame", frame = captureIndex }
            });
            trace.samples.Add(new TraceSample
            {
                time = Time.realtimeSinceStartupAsDouble,
                input = input ?? new TraceInput { delivery = "unity-input-system", kind = "initial", control = "", pressed = false, value = 0 },
                actor = new TraceActor
                {
                    id = contract.actorPath,
                    visible = actor.activeInHierarchy && IsRendered(actor),
                    position = new TraceVector { x = actor.transform.position.x, y = actor.transform.position.y, z = actor.transform.position.z }
                },
                events = events
            });
            captureIndex++;
        }

        private static byte[] RenderFrame(int width, int height)
        {
            var camera = Camera.main;
            if (camera == null) throw new InvalidOperationException("The scenario requires a tagged MainCamera for trusted frame capture.");
            var renderTexture = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
            var previousTarget = camera.targetTexture;
            var previousActive = RenderTexture.active;
            try
            {
                camera.targetTexture = renderTexture;
                RenderTexture.active = renderTexture;
                camera.Render();
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                return texture.EncodeToPNG();
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                UnityEngine.Object.DestroyImmediate(texture);
                UnityEngine.Object.DestroyImmediate(renderTexture);
            }
        }

        private static Dictionary<string, string> ObserveStates(List<StateObservation> observations)
        {
            var values = new Dictionary<string, string>();
            foreach (var observation in observations)
            {
                var subject = FindRequired(observation.path, $"state observation {observation.id}");
                var component = subject.GetComponent(observation.component);
                if (component == null) throw new InvalidOperationException($"Component {observation.component} was not found at {observation.path}.");
                var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
                var property = component.GetType().GetProperty(observation.member, flags);
                var field = component.GetType().GetField(observation.member, flags);
                if (property == null && field == null) throw new InvalidOperationException($"Member {observation.member} was not found on {observation.component}.");
                var value = property != null ? property.GetValue(component) : field.GetValue(component);
                values[observation.id] = value == null ? "null" : value.ToString();
            }
            return values;
        }

        private static List<TraceEvent> StateEvents(List<StateObservation> observations, Dictionary<string, string> before, Dictionary<string, string> after, int latencyFrames)
        {
            var events = new List<TraceEvent>();
            foreach (var observation in observations)
            {
                if (before.TryGetValue(observation.id, out var previous) && after.TryGetValue(observation.id, out var current) && previous != current)
                {
                    events.Add(new TraceEvent { kind = "state-change", cause = "player-input", state = string.IsNullOrEmpty(observation.state) ? observation.id : observation.state, previous = previous, current = current, latencyFrames = latencyFrames });
                }
            }
            return events;
        }

        private static bool Changed(Dictionary<string, string> before, Dictionary<string, string> after)
        {
            foreach (var pair in before) if (!after.TryGetValue(pair.Key, out var current) || current != pair.Value) return true;
            return false;
        }

        private static bool IsRendered(GameObject actor)
        {
            var renderers = actor.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0) return true;
            foreach (var renderer in renderers) if (renderer.enabled && renderer.gameObject.activeInHierarchy) return true;
            return false;
        }

        private static GameObject FindRequired(string path, string label)
        {
            var subject = GameObject.Find(path);
            if (subject == null) throw new InvalidOperationException($"The {label} path does not resolve in the running scene: {path}");
            return subject;
        }

        private static T ReadJson<T>(string path, string label)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) throw new FileNotFoundException($"GameFactory {label} is missing.", path);
            var value = JsonUtility.FromJson<T>(File.ReadAllText(path));
            if (value == null) throw new InvalidDataException($"GameFactory {label} is malformed JSON.");
            return value;
        }

        private static void Validate(RequestEnvelope envelope, ScenarioContract contract, string output)
        {
            if (contract.apiVersion != ScenarioApi) throw new InvalidDataException($"Scenario must declare {ScenarioApi}.");
            if (string.IsNullOrWhiteSpace(contract.scenePath) || !contract.scenePath.StartsWith("Assets/", StringComparison.Ordinal)) throw new InvalidDataException("scenePath must be an Assets-relative Unity scene.");
            if (string.IsNullOrWhiteSpace(contract.actorPath)) throw new InvalidDataException("actorPath is required.");
            if (contract.steps == null || contract.steps.Count == 0) throw new InvalidDataException("At least one shipping input step is required.");
            if (contract.stateObservations == null || contract.stateObservations.Count == 0) throw new InvalidDataException("At least one state observation is required.");
            var outputRoot = Path.GetFullPath(envelope.outputDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var resultPath = Path.GetFullPath(output);
            if (!resultPath.StartsWith(outputRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Result path must remain beneath outputDirectory.");
        }

        private static Task NextUpdate()
        {
            return NextGameFrame();
        }

        private static async Task NextGameFrame()
        {
            var startingFrame = Time.frameCount;
            do
            {
                await NextEditorUpdate();
            }
            while (EditorApplication.isPlaying && Time.frameCount <= startingFrame);
        }

        private static Task NextEditorUpdate()
        {
            var completion = new TaskCompletionSource<bool>();
            void Tick()
            {
                EditorApplication.update -= Tick;
                completion.TrySetResult(true);
            }
            EditorApplication.update += Tick;
            return completion.Task;
        }

        private static Task EnterPlayMode()
        {
            if (EditorApplication.isPlaying) return Task.CompletedTask;
            var completion = new TaskCompletionSource<bool>();
            void Changed(PlayModeStateChange state)
            {
                if (state != PlayModeStateChange.EnteredPlayMode) return;
                EditorApplication.playModeStateChanged -= Changed;
                completion.TrySetResult(true);
            }
            EditorApplication.playModeStateChanged += Changed;
            EditorApplication.EnterPlaymode();
            return completion.Task;
        }

        private static Task ExitPlayMode()
        {
            if (!EditorApplication.isPlaying) return Task.CompletedTask;
            var completion = new TaskCompletionSource<bool>();
            void Changed(PlayModeStateChange state)
            {
                if (state != PlayModeStateChange.EnteredEditMode) return;
                EditorApplication.playModeStateChanged -= Changed;
                completion.TrySetResult(true);
            }
            EditorApplication.playModeStateChanged += Changed;
            EditorApplication.ExitPlaymode();
            return completion.Task;
        }

        [Serializable] private sealed class RequestEnvelope { public string apiVersion; public string scenarioPath; public string outputDirectory; public string playModeStatePath; }
        [Serializable] private sealed class PlayModeSettings { public bool enabled; public int options; }
        [Serializable] private sealed class ScenarioContract
        {
            public string apiVersion;
            public string id = "primary";
            public string scenePath;
            public string actorPath;
            public string targetPath;
            public float interactionRange = 2f;
            public int captureEveryFrames = 10;
            public int captureWidth = 960;
            public int captureHeight = 540;
            public List<StateObservation> stateObservations = new List<StateObservation>();
            public List<InputStep> steps = new List<InputStep>();
        }
        [Serializable] private sealed class StateObservation { public string id; public string path; public string component; public string member; public string state; }
        [Serializable] private sealed class InputStep { public string control; public bool pressed; public float value = 1f; public int frames = 1; public int settleFrames; public bool interaction; }
        [Serializable] private sealed class ScenarioResult
        {
            public string apiVersion;
            public string status;
            public ScenarioMetrics metrics = new ScenarioMetrics();
            public List<Artifact> artifacts = new List<Artifact>();
            public List<Violation> violations = new List<Violation>();
            public ResultMetadata metadata = new ResultMetadata();
        }
        [Serializable] private sealed class ScenarioMetrics { public int unity_scenario_frames; public int unity_scenario_captures; }
        [Serializable] private sealed class ResultMetadata { public string producer; public string scenarioId; }
        [Serializable] private sealed class Artifact { public string kind; public string path; public string mediaType; public string label; public ArtifactMetadata metadata = new ArtifactMetadata(); }
        [Serializable] private sealed class ArtifactMetadata { public string producer; public string protocol; public string evidenceRole; public int frame; }
        [Serializable] private sealed class Violation { public string code; public string message; public string severity; }
        [Serializable] private sealed class EmbodiedTrace { public string apiVersion; public string producer; public List<TraceSample> samples = new List<TraceSample>(); }
        [Serializable] private sealed class TraceSample { public double time; public TraceInput input; public TraceActor actor; public List<TraceEvent> events = new List<TraceEvent>(); }
        [Serializable] private sealed class TraceInput { public string delivery; public string kind; public string control; public bool pressed; public float value; }
        [Serializable] private sealed class TraceActor { public string id; public bool visible; public TraceVector position; }
        [Serializable] private sealed class TraceVector { public float x; public float y; public float z; }
        [Serializable] private sealed class TraceEvent
        {
            public string kind;
            public string targetId;
            public float distance;
            public float range;
            public string outcome;
            public string cause;
            public string state;
            public string previous;
            public string current;
            public int latencyFrames;
        }
    }
}
