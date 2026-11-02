"""随机请求间隔与已有共享限流退避的组合行为。"""

import unittest
from unittest.mock import Mock, patch

from tag_collect import Collector
from tag_session import CollectError, Session


class Clock:
    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class RandomDelayTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("tag_session.load_cookies", return_value={}))
        self.enterContext(patch("tag_session.system_proxy", return_value={}))
        self.session = Session("pixiv", interval=0.9, retries=2)
        self.session._local.last = 0
        self.clock = Clock()
        self.enterContext(patch("tag_session.time.monotonic", side_effect=lambda: self.clock.now))
        self.enterContext(patch("tag_session.time.sleep", side_effect=self.clock.sleep))

    def test_each_request_including_first_gets_an_independent_random_sleep(self):
        self.session.set_random_delay(2, 4)
        with patch("tag_session.random.uniform", side_effect=[2.25, 3.75]) as draw:
            self.session.throttle()
            self.session.throttle()
        self.assertEqual(self.clock.sleeps, [2.25, 3.75])
        self.assertEqual(draw.call_args_list, [((2, 4),), ((2, 4),)])

    def test_a_new_shared_penalty_during_random_sleep_still_delays_the_request(self):
        self.session.set_random_delay(2, 4)

        def sleep(seconds):
            self.clock.sleep(seconds)
            if len(self.clock.sleeps) == 1:
                self.session.penalty(10)

        with patch("tag_session.random.uniform", return_value=3), patch("tag_session.time.sleep", side_effect=sleep):
            self.session.throttle()
        self.assertEqual(self.clock.sleeps, [3, 5, 5])
        self.assertEqual(self.clock.now, 113)

    def test_a_429_retry_waits_for_shared_penalty_and_draws_a_new_delay(self):
        self.session.set_random_delay(2, 4)
        rejected = Mock(status_code=429, ok=False)
        accepted = Mock(status_code=200, ok=True)
        client = Mock()
        client.request.side_effect = [rejected, accepted]
        self.session._local.client = client
        with patch("tag_session.random.uniform", side_effect=[2, 4]):
            self.assertIs(self.session.request("GET", "https://example.invalid/"), accepted)
        self.assertEqual(self.clock.sleeps, [2, 4, 4])
        self.assertEqual(client.request.call_count, 2)

    def test_fixed_interval_is_unchanged_when_random_delay_is_disabled(self):
        self.session._local.last = 99.5
        with patch("tag_session.random.uniform") as draw:
            self.session.throttle()
        self.assertEqual(len(self.clock.sleeps), 1)
        self.assertAlmostEqual(self.clock.sleeps[0], 0.4)
        draw.assert_not_called()

    def test_invalid_random_ranges_are_rejected(self):
        for bounds in [(0.1, 4), (4, 2), (float("nan"), 4), (2, float("inf"))]:
            with self.subTest(bounds=bounds), self.assertRaises(CollectError):
                self.session.set_random_delay(*bounds)

    def test_configures_pixiv_source_without_changing_other_platforms(self):
        collector = Collector.__new__(Collector)
        collector.interval = 0.9
        collector.delay_range = (2, 4)
        pixiv, bilibili = Mock(), Mock()
        with patch("tag_collect.SOURCES", {"pixiv": lambda _: pixiv, "bilibili": lambda _: bilibili}):
            collector.create_source("pixiv")
            collector.create_source("bilibili")
        pixiv.session.set_random_delay.assert_called_once_with(2, 4)
        bilibili.session.set_random_delay.assert_not_called()


if __name__ == "__main__":
    unittest.main()
