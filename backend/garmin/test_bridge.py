import unittest
import io
import json
import tempfile
from unittest.mock import Mock, patch

import bridge
from bridge import course_payload, device_message


class CoursePayloadTest(unittest.TestCase):
    def test_builds_a_watch_course_from_imported_geometry(self):
        parsed = {"geoPoints": [
            {"latitude": 59.9, "longitude": 10.7, "elevation": 12},
            {"latitude": 59.91, "longitude": 10.71, "elevation": 14},
        ]}
        payload = course_payload(parsed, "Forest run", 1)
        self.assertEqual(payload["courseName"], "Forest run")
        self.assertEqual(payload["coursePrivacy"], 2)
        self.assertEqual(payload["activityTypePk"], 1)
        self.assertGreater(payload["distanceMeter"], 0)
        self.assertEqual(payload["courseLines"][0]["numberOfPoints"], 2)
        self.assertEqual(payload["geoPoints"][1]["distance"], payload["distanceMeter"])

    def test_rejects_an_empty_import(self):
        with self.assertRaisesRegex(ValueError, "could not read"):
            course_payload({"geoPoints": []}, "Empty", 2)

    def test_device_message_queues_the_created_fit_course(self):
        message = device_message(42, "123", "Forest run")[0]
        self.assertEqual(message["deviceId"], 123)
        self.assertEqual(message["metaDataId"], 42)
        self.assertEqual(message["messageUrl"],
                         "course-service/course/fit/42/123?elevation=true")


class LoginTest(unittest.TestCase):
    def test_no_mfa_login_persists_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock()
            client.login.return_value = (None, None)
            request = {"dataDir": directory,
                       "userId": "11111111-1111-1111-1111-111111111111",
                       "action": "connect", "email": "runner@example.com",
                       "password": "secret"}
            stdout = io.StringIO()
            with patch.object(bridge, "Garmin", return_value=client), \
                    patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n")), \
                    patch.object(bridge.sys, "stdout", stdout):
                bridge.main()
            self.assertEqual(json.loads(stdout.getvalue()), {"connected": True})
            client.client.dump.assert_called_once()

    def test_mfa_login_resumes_and_persists_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock()
            client.login.return_value = ("needs_mfa", None)
            request = {"dataDir": directory,
                       "userId": "11111111-1111-1111-1111-111111111111",
                       "action": "connect", "email": "runner@example.com",
                       "password": "secret"}
            stdout = io.StringIO()
            input_lines = json.dumps(request) + "\n" + json.dumps({"code": "123456"}) + "\n"
            with patch.object(bridge, "Garmin", return_value=client), \
                    patch.object(bridge.sys, "stdin", io.StringIO(input_lines)), \
                    patch.object(bridge.sys, "stdout", stdout):
                bridge.main()
            replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(replies, [{"mfaRequired": True}, {"connected": True}])
            client.resume_login.assert_called_once_with({}, "123456")
            client.client.dump.assert_called_once()

    def test_rejected_credentials_are_reported_as_auth_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock()
            client.login.side_effect = bridge.GarminConnectAuthenticationError("401")
            request = {"dataDir": directory,
                       "userId": "11111111-1111-1111-1111-111111111111",
                       "action": "connect", "email": "runner@example.com",
                       "password": "wrong"}
            stdout = io.StringIO()
            with patch.object(bridge, "Garmin", return_value=client), \
                    patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n")), \
                    patch.object(bridge.sys, "stdout", stdout):
                bridge.run()
            self.assertEqual(json.loads(stdout.getvalue()),
                             {"error": "Garmin rejected the email or password", "auth": True})


if __name__ == "__main__":
    unittest.main()
