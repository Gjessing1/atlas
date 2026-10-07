#!/usr/bin/env python3
"""Small process boundary for Garmin Connect. Requests and secrets travel on stdin only."""

import json
import math
import os
import sys
import time
from pathlib import Path

from garminconnect import (Garmin, GarminConnectAuthenticationError,
                          GarminConnectTooManyRequestsError)


class BridgeInputError(ValueError):
    """A deliberately safe error that can be shown to the Atlas user."""


class BridgeAuthError(BridgeInputError):
    """Garmin itself refused the credentials or code, as opposed to being unreachable."""


def answer(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def fail(message, auth=False):
    answer({"error": message, "auth": True} if auth else {"error": message})


def token_path(root, user_id):
    # User ids come from Atlas's UUID account store, never from a client path.
    if len(user_id) != 36 or any(c not in "0123456789abcdef-" for c in user_id):
        raise BridgeInputError("Invalid account")
    base = Path(root) / "garmin"
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(base, 0o700)
    directory = base / user_id
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    return str(directory)


def haversine(a, b):
    p1, p2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dlat = p2 - p1
    dlon = math.radians(b["longitude"] - a["longitude"])
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def bearing(a, b):
    p1, p2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dlon = math.radians(b["longitude"] - a["longitude"])
    east = math.sin(dlon) * math.cos(p2)
    north = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(east, north)) + 360) % 360


def course_payload(parsed, name, activity_type):
    points = parsed.get("geoPoints") or []
    if len(points) < 2:
        raise BridgeInputError("Garmin could not read a route from this GPX")
    distance = 0.0
    ascent = 0.0
    descent = 0.0
    clean = []
    for index, point in enumerate(points):
        lat, lon = float(point["latitude"]), float(point["longitude"])
        elevation = float(point.get("elevation") or 0)
        if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180:
            raise BridgeInputError("Garmin returned invalid route coordinates")
        if not math.isfinite(elevation):
            raise BridgeInputError("Garmin returned invalid route elevation")
        if index:
            distance += haversine(clean[-1], {"latitude": lat, "longitude": lon})
            elevation_delta = elevation - clean[-1]["elevation"]
            ascent += max(0, elevation_delta)
            descent += max(0, -elevation_delta)
        clean.append({"latitude": lat, "longitude": lon,
                      "elevation": elevation, "distance": distance,
                      "timestamp": point.get("timestamp")})
    lats = [point["latitude"] for point in clean]
    lons = [point["longitude"] for point in clean]
    bbox = {"center": {"latitude": (min(lats) + max(lats)) / 2,
                       "longitude": (min(lons) + max(lons)) / 2},
            "lowerLeft": {"latitude": min(lats), "longitude": min(lons)},
            "upperRight": {"latitude": max(lats), "longitude": max(lons)},
            "lowerLeftLatIsSet": True, "lowerLeftLongIsSet": True,
            "upperRightLatIsSet": True, "upperRightLongIsSet": True}
    start = {"latitude": clean[0]["latitude"], "longitude": clean[0]["longitude"],
             "elevation": clean[0]["elevation"], "distance": None, "timestamp": None}
    line = {"courseId": None, "sortOrder": 1, "numberOfPoints": len(clean),
            "distanceInMeters": distance, "bearing": bearing(clean[0], clean[-1]), "points": clean,
            "coordinateSystem": "WGS84", "originalCoordinateSystem": "WGS84"}
    return {"courseName": name, "coursePrivacy": 2,
            "openStreetMap": False, "matchedToSegments": False,
            "rulePK": 2, "sourceTypeId": 3,
            "distanceMeter": distance, "elevationGainMeter": ascent,
            "elevationLossMeter": descent,
            "startPoint": start, "coursePoints": [], "boundingBox": bbox,
            "hasTurnDetectionDisabled": False, "activityTypePk": activity_type,
            "includeLaps": False, "courseLines": [line],
            "coordinateSystem": "WGS84", "hasPaceBand": False,
            "hasPowerGuide": False, "favorite": False, "geoPoints": clean}


def device_message(course_id, device_id, name):
    if not str(device_id).isdigit() or not str(course_id).isdigit():
        raise BridgeInputError("Invalid Garmin device or course")
    return [{"deviceId": int(device_id),
             "messageUrl": f"course-service/course/fit/{course_id}/{device_id}?elevation=true",
             "messageType": "courses", "messageName": name, "groupName": None,
             "priority": 0, "fileType": "FIT", "metaDataId": int(course_id)}]


# Garmin type ids for the sports Atlas offers when editing a course (GARMIN_COURSE_SPORTS in
# @atlas/core). Read from Garmin's activity-type table 2026-10-04; any other key is refused.
COURSE_SPORTS = {"running": 1, "trail_running": 6, "cycling": 2, "road_biking": 10,
                 "mountain_biking": 5, "gravel_cycling": 143, "hiking": 3, "walking": 9,
                 "cross_country_skiing_ws": 171, "backcountry_skiing": 203}

# Garmin answers 429 "not yet ready to delete or update" for a few seconds after a course is
# created or edited (10 s observed). That is not rate limiting, so wait it out here.
NOT_READY_WAITS = (3, 6, 10, 15)


def when_ready(work):
    for wait in NOT_READY_WAITS + (None,):
        try:
            return work()
        except Exception as error:
            if wait is None or "not yet ready" not in str(error):
                raise
            time.sleep(wait)


def parse_course_id(value):
    if not isinstance(value, str) or not value.isdigit() or len(value) > 20:
        raise BridgeInputError("Invalid Garmin course")
    return value


def course_summary(course):
    activity = course.get("activityType") or {}
    return {"id": str(course["courseId"]),
            "name": course.get("courseName") or "Garmin course",
            "type": activity.get("typeKey"),
            "distanceM": course.get("distanceInMeters"),
            "ascentM": course.get("elevationGainInMeters"),
            "updated": course.get("updatedDate") or course.get("createdDate")}


def main():
    command = json.loads(sys.stdin.readline())
    directory = token_path(command["dataDir"], command["userId"])
    action = command["action"]
    if action == "status":
        answer({"connected": (Path(directory) / "garmin_tokens.json").exists()})
        return
    if action == "disconnect":
        Garmin().logout(directory)
        answer({"connected": False})
        return
    if action == "connect":
        garmin = Garmin(command["email"], command["password"], return_on_mfa=True)
        try:
            status, _ = garmin.login(directory)
        except GarminConnectAuthenticationError:
            raise BridgeAuthError("Garmin rejected the email or password")
        if status == "needs_mfa":
            answer({"mfaRequired": True})
            followup = json.loads(sys.stdin.readline())
            try:
                garmin.resume_login({}, followup["code"])
            except GarminConnectAuthenticationError:
                raise BridgeAuthError("Garmin rejected the code")
            garmin.client.dump(directory)
        else:
            # return_on_mfa exits Garmin.login before its ordinary token dump.
            garmin.client.dump(directory)
        answer({"connected": True})
        return

    garmin = Garmin()
    garmin.login(directory)
    if action == "uploadCourse":
        gpx = command["gpx"].encode("utf-8")
        parsed = garmin.client.post("connect", "/course-service/course/import",
                                    files={"file": ("atlas-route.gpx", gpx,
                                                    "application/gpx+xml")}, api=True)
        activity_type = {"run": 1, "bike": 2, "hike": 3, "foot": 9}[command["profile"]]
        if command.get("sportOf"):
            # A replacement keeps the sport of the course it replaces, including sports
            # (ice skating, say) that no routing profile maps to.
            original = garmin.connectapi(
                f"/course-service/course/{parse_course_id(command['sportOf'])}")
            if isinstance(original.get("activityTypePk"), int):
                activity_type = original["activityTypePk"]
        payload = course_payload(parsed, command["name"], activity_type)
        created = garmin.client.post("connect", "/course-service/course",
                                     json=payload, api=True)
        course_id = created.get("courseId")
        if not isinstance(course_id, int) or course_id <= 0:
            raise BridgeInputError("Garmin did not confirm the course")
        verified = garmin.connectapi(f"/course-service/course/{course_id}")
        if verified.get("courseName") != command["name"]:
            raise BridgeInputError("Garmin created a course but did not verify its name")
        queued = False
        if command.get("deviceId"):
            try:
                garmin.client.post(
                    "connect", "/device-service/devicemessage/messages",
                    json=device_message(course_id, command["deviceId"], command["name"]))
                queued = True
            except Exception:
                # The course already exists; report that result even when Garmin
                # refuses device delivery, so the user can send it from Connect.
                queued = False
        answer({"id": course_id,
                "url": f"https://connect.garmin.com/modern/course/{course_id}",
                "queued": queued})
    elif action == "courses":
        courses = garmin.connectapi("/web-gateway/course/owner/").get("coursesForUser") or []
        answer({"courses": [course_summary(c) for c in courses
                            if isinstance(c.get("courseId"), int)]})
    elif action == "courseGpx":
        data = garmin.download(f"/course-service/course/gpx/{parse_course_id(command['id'])}")
        if len(data) > 20_000_000:
            raise BridgeInputError("Garmin course GPX is too large to import")
        answer({"gpx": data.decode("utf-8")})
    elif action == "updateCourse":
        cid = parse_course_id(command["id"])
        course = garmin.connectapi(f"/course-service/course/{cid}")
        # Garmin's PUT replaces the whole course, so send back exactly what it gave us with
        # only the edited fields changed; geometry and points are never touched here.
        if "name" in command:
            name = command["name"]
            if not isinstance(name, str) or not name.strip() or len(name) > 100:
                raise BridgeInputError("Invalid course name")
            course["courseName"] = name.strip()
        if "sport" in command:
            if command["sport"] not in COURSE_SPORTS:
                raise BridgeInputError("Unsupported course sport")
            course["activityTypePk"] = COURSE_SPORTS[command["sport"]]
        when_ready(lambda: garmin.client.put("connect", f"/course-service/course/{cid}",
                                             json=course, api=True))
        answer({"updated": True})
    elif action == "deleteCourse":
        cid = parse_course_id(command["id"])
        when_ready(lambda: garmin.client.delete("connect", f"/course-service/course/{cid}",
                                                api=True))
        answer({"deleted": True})
    elif action == "sendCourse":
        cid = parse_course_id(command["id"])
        course = garmin.connectapi(f"/course-service/course/{cid}")
        garmin.client.post("connect", "/device-service/devicemessage/messages",
                           json=device_message(cid, command.get("deviceId"),
                                               course.get("courseName") or "Atlas course"))
        answer({"queued": True})
    elif action == "devices":
        devices = garmin.get_devices()
        answer({"devices": [{"id": str(d["deviceId"]),
                             "name": d.get("displayName") or d.get("productDisplayName")
                                     or f"Garmin device {d['deviceId']}"}
                            for d in devices if str(d.get("deviceId", "")).isdigit()]})
    elif action == "activities":
        start = command.get("start", 0)
        if not isinstance(start, int) or start < 0 or start > 100000:
            raise BridgeInputError("Invalid activity offset")
        activities = garmin.get_activities(start, 30)
        answer({"activities": [{"id": str(a["activityId"]),
                                "name": a.get("activityName") or "Garmin activity",
                                "date": a.get("startTimeLocal"),
                                "type": (a.get("activityType") or {}).get("typeKey"),
                                "hasRoute": a.get("hasPolyline") is not False}
                               for a in activities if a.get("activityId")]})
    elif action == "activityGpx":
        activity_id = command["id"]
        if not activity_id.isdigit() or len(activity_id) > 20:
            raise BridgeInputError("Invalid activity id")
        data = garmin.download_activity(activity_id, dl_fmt=Garmin.ActivityDownloadFormat.GPX)
        if len(data) > 20_000_000:
            raise BridgeInputError("Garmin activity GPX is too large to import")
        answer({"gpx": data.decode("utf-8")})
    else:
        raise BridgeInputError("Unknown action")


def run():
    try:
        main()
    except Exception as error:
        # Library errors may contain request context or tokens; never echo them.
        if isinstance(error, BridgeInputError):
            message = str(error)
        elif "not yet ready" in str(error):
            message = "Garmin is still processing this course; try again in a minute"
        elif isinstance(error, GarminConnectTooManyRequestsError):
            message = "Garmin is rate-limiting this server; try again later"
        else:
            message = "Garmin Connect request failed"
        fail(message, isinstance(error, BridgeAuthError))


if __name__ == "__main__":
    run()
