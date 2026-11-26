"""A Gymnasium environment for Icaro Engine: Quake played headless.

Web-only addition, no C counterpart. It starts the agent MCP server
(server/agent_mcp.ts) as a child process and drives its rl tier over MCP's
stdio JSON-RPC: rl_spec gives the spaces, start resets, rl_step steps. The
rl tier itself (observation layout, actions, reward, episode ends) is
src/agent.js; docs/agent-interface.md describes it.

Run from anywhere (the server is started at the repository root, since it
reads static/pak0.pak, the shareware episode):

    uv run --with gymnasium --with numpy tools/gym/icaro_env.py

That runs Gymnasium's env checker and one episode of random actions. To use
it in your own code:

    import sys; sys.path.insert(0, "tools/gym")
    from icaro_env import IcaroEnv
    env = IcaroEnv(map="e1m1", skill=1, ents=16, rays=32, map_size=0)
    obs, info = env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
    env.close()

Needs Deno on PATH (the version in .tool-versions), Python 3.9+, gymnasium
and numpy. Standard library otherwise. Not linted or run in CI; the call
sequence it makes is tested in tests/agent_rl_test.js.

Observation: a float32 Box of rl_spec's size and bounds. Values come to 3
decimals over JSON. Action: MultiDiscrete(rl_spec's action.nvec), the 8
components move, strafe, turn, look, attack, jump, speed, weapon. Each step
runs `tics` game tics (1/72 s each; default 4). terminated means the episode
ended ("died", "level done", "level changed" or "level restarted", in
info["why"]); truncated means max_episode_steps was reached. Same seed, same
actions: same observations.
"""

import json
import os
import subprocess
import sys

import gymnasium as gym
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER = ["deno", "run", "--no-prompt", "--allow-read=static", "server/agent_mcp.ts"]
RL_VERSION = 1


class McpClient:
    """Newline-delimited JSON-RPC to the agent MCP server over its stdio."""

    def __init__(self, cmd=SERVER, cwd=REPO):
        # stderr carries the engine's console: inherit it or drop it, never
        # an undrained pipe (it would fill and stall the server)
        self.proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.next_id = 1
        init = self.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "icaro-gym", "version": "1"},
            },
        )
        if "result" not in init:
            raise RuntimeError("initialize: " + json.dumps(init))
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params):
        rid = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError("agent MCP server exited")
            msg = json.loads(line)
            if msg.get("id") == rid:
                return msg

    def call(self, name, args):
        """A tool's text, first line only (the rest is the tic/hash footer)."""
        msg = self.request("tools/call", {"name": name, "arguments": args})
        if "error" in msg:
            raise RuntimeError(name + ": " + json.dumps(msg["error"]))
        result = msg["result"]
        text = result["content"][0]["text"]
        if result.get("isError") is True:
            raise RuntimeError(name + ": " + text)
        return text.split("\n", 1)[0]

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


class IcaroEnv(gym.Env):
    """Quake (shareware e1 by default) as a Gymnasium env."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        map="e1m1",
        skill=1,
        ents=16,
        rays=32,
        map_size=0,
        truth=True,
        tics=4,
        reward=None,
        max_episode_steps=None,
        server_cmd=SERVER,
    ):
        super().__init__()
        self.map = map
        self.skill = skill
        self.tics = tics
        self.max_episode_steps = max_episode_steps
        self.layout = {"ents": ents, "rays": rays, "map": map_size, "truth": truth}
        self.reward = reward
        self.client = McpClient(server_cmd)
        self.spec_json = json.loads(self.client.call("rl_spec", self.layout))
        if self.spec_json["version"] != RL_VERSION:
            raise RuntimeError("rl_spec version %r" % self.spec_json["version"])
        self.observation_space = gym.spaces.Box(
            low=np.array(self.spec_json["low"], dtype=np.float32),
            high=np.array(self.spec_json["high"], dtype=np.float32),
            dtype=np.float32,
        )
        action = self.spec_json["action"]
        self.action_space = gym.spaces.MultiDiscrete(action["nvec"])
        self.noop = list(action["noop"])
        self.steps = 0

    def _step(self, action, tics):
        args = {"action": [int(a) for a in action], "tics": tics, **self.layout}
        if self.reward is not None:
            args["reward"] = self.reward
        r = json.loads(self.client.call("rl_step", args))
        obs = np.asarray(r["obs"], dtype=np.float32)
        return obs, float(r["reward"]), r["terminated"], {"why": r["why"], "tics": r["tics"]}

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is None:
            # reproducible from the env's own generator
            seed = int(self.np_random.integers(0, 2**31 - 1))
        opts = options or {}
        self.client.call(
            "start",
            {"map": opts.get("map", self.map), "skill": opts.get("skill", self.skill), "seed": seed},
        )
        self.steps = 0
        obs, _, _, info = self._step(self.noop, 0)
        return obs, info

    def step(self, action):
        obs, reward, terminated, info = self._step(action, self.tics)
        self.steps += 1
        truncated = (
            not terminated
            and self.max_episode_steps is not None
            and self.steps >= self.max_episode_steps
        )
        return obs, reward, terminated, truncated, info

    def close(self):
        self.client.close()


def main():
    import time

    from gymnasium.utils.env_checker import check_env

    env = IcaroEnv(map_size=9, max_episode_steps=2000)
    try:
        check_env(env, skip_render_check=True)
        obs, info = env.reset(seed=1)
        env.action_space.seed(1)
        total, steps, t0 = 0.0, 0, time.perf_counter()
        terminated = truncated = False
        while not (terminated or truncated):
            obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
            total += reward
            steps += 1
        dt = time.perf_counter() - t0
        print(
            "episode: %d steps, reward %.3f, %s, %.0f steps/s"
            % (steps, total, info["why"] or "truncated", steps / dt)
        )
    finally:
        env.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
