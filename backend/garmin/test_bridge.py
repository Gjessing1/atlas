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


class CourseActionTest(unittest.TestCase):
    def call(self, client, request):
        with tempfile.TemporaryDirectory() as directory:
            stdout = io.StringIO()
            request = {"dataDir": directory,
                       "userId": "11111111-1111-1111-1111-111111111111", **request}
            with patch.object(bridge, "Garmin", return_value=client), \
                    patch.object(bridge.time, "sleep") as sleep, \
                    patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n")), \
                    patch.object(bridge.sys, "stdout", stdout):
                bridge.run()
            self.sleeps = [c.args[0] for c in sleep.call_args_list]
            return json.loads(stdout.getvalue())

    def test_lists_the_owners_courses(self):
        client = Mock()
        client.connectapi.return_value = {"coursesForUser": [
            {"courseId": 7, "courseName": "18k", "distanceInMeters": 18028.0,
             "elevationGainInMeters": 536.1, "updatedDate": 1783259286000,
             "activityType": {"typeKey": "trail_running"}}]}
        reply = self.call(client, {"action": "courses"})
        client.connectapi.assert_called_once_with("/web-gateway/course/owner/")
        self.assertEqual(reply, {"courses": [
            {"id": "7", "name": "18k", "type": "trail_running", "distanceM": 18028.0,
             "ascentM": 536.1, "updated": 1783259286000}]})

    def test_edits_only_name_and_sport_and_keeps_the_geometry(self):
        client = Mock()
        course = {"courseId": 7, "courseName": "Old", "activityTypePk": 9,
                  "geoPoints": [{"latitude": 59.9}]}
        client.connectapi.return_value = dict(course)
        reply = self.call(client, {"action": "updateCourse", "id": "7",
                                   "name": " New ", "sport": "trail_running"})
        self.assertEqual(reply, {"updated": True})
        path = client.client.put.call_args.args[1]
        sent = client.client.put.call_args.kwargs["json"]
        self.assertEqual(path, "/course-service/course/7")
        self.assertEqual(sent, {**course, "courseName": "New", "activityTypePk": 6})

    def test_refuses_a_sport_outside_the_offered_list(self):
        client = Mock()
        client.connectapi.return_value = {"courseId": 7}
        reply = self.call(client, {"action": "updateCourse", "id": "7", "sport": "golf"})
        self.assertEqual(reply, {"error": "Unsupported course sport"})
        client.client.put.assert_not_called()

    def test_waits_out_garmins_not_ready_window_before_deleting(self):
        client = Mock()
        client.client.delete.side_effect = [
            Exception("API Error 429 - The course [7] is not yet ready to delete or update"),
            {}]
        self.assertEqual(self.call(client, {"action": "deleteCourse", "id": "7"}),
                         {"deleted": True})
        self.assertEqual(self.sleeps, [3])
        self.assertEqual(client.client.delete.call_count, 2)

    def test_reports_a_course_that_stays_unready(self):
        client = Mock()
        client.client.delete.side_effect = Exception("429 - not yet ready to delete or update")
        reply = self.call(client, {"action": "deleteCourse", "id": "7"})
        self.assertEqual(reply["error"],
                         "Garmin is still processing this course; try again in a minute")
        self.assertEqual(self.sleeps, list(bridge.NOT_READY_WAITS))

    def test_does_not_retry_other_failures(self):
        client = Mock()
        client.client.delete.side_effect = Exception("500")
        reply = self.call(client, {"action": "deleteCourse", "id": "7"})
        self.assertEqual(reply, {"error": "Garmin Connect request failed"})
        self.assertEqual(client.client.delete.call_count, 1)

    def test_rejects_a_non_numeric_course_id(self):
        client = Mock()
        reply = self.call(client, {"action": "deleteCourse", "id": "7/../../user"})
        self.assertEqual(reply, {"error": "Invalid Garmin course"})
        client.client.delete.assert_not_called()

    def test_sends_an_existing_course_to_a_device(self):
        client = Mock()
        client.connectapi.return_value = {"courseId": 7, "courseName": "18k"}
        reply = self.call(client, {"action": "sendCourse", "id": "7", "deviceId": "123"})
        self.assertEqual(reply, {"queued": True})
        message = client.client.post.call_args.kwargs["json"][0]
        self.assertEqual((message["metaDataId"], message["deviceId"], message["messageName"]),
                         (7, 123, "18k"))

    def test_resending_waits_for_a_recently_edited_course(self):
        client = Mock()
        client.connectapi.return_value = {"courseName": "18k"}
        client.client.post.side_effect = [Exception("429 - course not yet ready"), {}]
        reply = self.call(client, {"action": "sendCourse", "id": "7", "deviceId": "123"})
        self.assertEqual(reply, {"queued": True})
        self.assertEqual(self.sleeps, [3])
        self.assertEqual(client.client.post.call_count, 2)

    def test_a_replacement_upload_keeps_the_replaced_courses_sport(self):
        client = Mock()
        points = [{"latitude": 59.9, "longitude": 10.7, "elevation": 1},
                  {"latitude": 59.91, "longitude": 10.71, "elevation": 2}]

        def post(_service, path, **_kwargs):
            return {"geoPoints": points} if path.endswith("/import") else {"courseId": 99}
        client.client.post.side_effect = post

        def get(path):
            # The replaced course is ice skating, which no routing profile maps to.
            return ({"activityTypePk": 168} if path.endswith("/7") else
                    {"courseName": "Lake", "activityTypePk": 168})
        client.connectapi.side_effect = get
        reply = self.call(client, {"action": "uploadCourse", "name": "Lake", "profile": "hike",
                                   "gpx": "<gpx/>", "sportOf": "7"})
        self.assertEqual(reply["id"], 99)
        created = client.client.post.call_args_list[1].kwargs["json"]
        self.assertEqual(created["activityTypePk"], 168)

    def test_a_replacement_refuses_to_guess_a_missing_original_sport(self):
        client = Mock()
        client.client.post.return_value = {"geoPoints": [
            {"latitude": 59.9, "longitude": 10.7},
            {"latitude": 59.91, "longitude": 10.71}]}
        client.connectapi.return_value = {"courseId": 7}
        reply = self.call(client, {"action": "uploadCourse", "name": "Lake", "profile": "hike",
                                   "gpx": "<gpx/>", "sportOf": "7"})
        self.assertEqual(reply, {"error": "Garmin did not return the original course sport"})
        self.assertEqual(client.client.post.call_count, 1)

    def test_a_replacement_reports_a_sport_garmin_changed(self):
        client = Mock()
        points = [{"latitude": 59.9, "longitude": 10.7},
                  {"latitude": 59.91, "longitude": 10.71}]
        client.client.post.side_effect = [{"geoPoints": points}, {"courseId": 99}]
        client.connectapi.side_effect = [{"activityTypePk": 168},
                                         {"courseName": "Lake", "activityTypePk": 3}]
        reply = self.call(client, {"action": "uploadCourse", "name": "Lake", "profile": "hike",
                                   "gpx": "<gpx/>", "sportOf": "7"})
        self.assertEqual(reply, {"error": "Garmin created a course but did not keep its sport"})
        client.client.post.assert_any_call("connect", "/course-service/course", json=unittest.mock.ANY,
                                           api=True)

    def test_a_new_course_waits_until_garmin_can_queue_it(self):
        client = Mock()
        points = [{"latitude": 59.9, "longitude": 10.7},
                  {"latitude": 59.91, "longitude": 10.71}]

        def post(_service, path, **_kwargs):
            if path.endswith("/import"):
                return {"geoPoints": points}
            if path.endswith("/course"):
                return {"courseId": 99}
            if client.client.post.call_count == 3:
                raise Exception("429 - course not yet ready")
            return {}

        client.client.post.side_effect = post
        client.connectapi.return_value = {"courseName": "Lake"}
        reply = self.call(client, {"action": "uploadCourse", "name": "Lake", "profile": "hike",
                                   "gpx": "<gpx/>", "deviceId": "123"})
        self.assertEqual(reply["queued"], True)
        self.assertEqual(self.sleeps, [3])
        self.assertEqual(client.client.post.call_count, 4)

    def test_a_replacement_refuses_a_bad_source_course(self):
        client = Mock()
        client.client.post.return_value = {"geoPoints": []}
        reply = self.call(client, {"action": "uploadCourse", "name": "Lake", "profile": "hike",
                                   "gpx": "<gpx/>", "sportOf": "7/../x"})
        self.assertEqual(reply, {"error": "Invalid Garmin course"})


if __name__ == "__main__":
    unittest.main()
