"""
THE OWNER'S AWS ACCOUNT, LOOKED AT READ-ONLY (owner, 2026-10-31: added
ReadOnlyAccess to the usgs-lidar user "so you can make sure there's not any
issues with my account configurations"). Prints what it finds with the
account number hidden; changes nothing; costs nothing.
"""
import re

import boto3
import botocore

hide = lambda s: re.sub(r"\d{12}", "<account>", str(s))  # noqa: E731


def step(label, fn):
    try:
        print(f"{label}: {hide(fn())}")
    except botocore.exceptions.ClientError as e:
        print(f"{label}: refused ({e.response['Error']['Code']}) {hide(e.response['Error'].get('Message', ''))[:600]}")
    except Exception as e:  # noqa: BLE001
        print(f"{label}: could not ask ({type(e).__name__}: {hide(e)[:160]})")


iam = boto3.client("iam")
sts = boto3.client("sts")
arn = sts.get_caller_identity()["Arn"]
user = arn.rsplit("/", 1)[-1]
print(f"WHO: {hide(arn)}")
step("USER (created, boundary)", lambda: {k: v for k, v in iam.get_user(UserName=user)["User"].items()
                                          if k in ("CreateDate", "PermissionsBoundary", "Tags")})
step("POLICIES ATTACHED TO THE USER", lambda: [p["PolicyName"] for p in iam.list_attached_user_policies(UserName=user)["AttachedPolicies"]])
step("POLICIES WRITTEN INTO THE USER", lambda: iam.list_user_policies(UserName=user)["PolicyNames"])
step("GROUPS", lambda: [g["GroupName"] for g in iam.list_groups_for_user(UserName=user)["Groups"]])
step("ACCESS KEYS (status, created)", lambda: [(k["Status"], str(k["CreateDate"])[:19]) for k in iam.list_access_keys(UserName=user)["AccessKeyMetadata"]])
step("ACCOUNT SUMMARY (users, policies, MFA)", lambda: {k: v for k, v in iam.get_account_summary()["SummaryMap"].items()
                                                        if k in ("Users", "Policies", "AccountMFAEnabled", "Roles")})
def org():
    o = boto3.client("organizations").describe_organization()["Organization"]
    me = sts.get_caller_identity()["Account"]
    return {"featureSet": o.get("FeatureSet"), "id": o.get("Id"),
            "thisAccountIsTheManagementAccount": o.get("MasterAccountId") == me,
            "managementEmailDomain": (o.get("MasterAccountEmail") or "").split("@")[-1]}


step("ORGANIZATION", org)


def scps():
    c = boto3.client("organizations")
    me = sts.get_caller_identity()["Account"]
    out = []
    for p in c.list_policies_for_target(TargetId=me, Filter="SERVICE_CONTROL_POLICY")["Policies"]:
        d = c.describe_policy(PolicyId=p["Id"])["Policy"]
        out.append({"name": p["Name"], "id": p["Id"], "awsManaged": p.get("AwsManaged"), "content": d.get("Content", "")[:1500]})
    return out


step("SERVICE CONTROL POLICIES ON THIS ACCOUNT", scps)


def plan():
    c = boto3.client("freetier", region_name="us-east-1")
    r = c.get_account_plan_state()
    return {k: v for k, v in r.items() if k != "ResponseMetadata"}


step("ACCOUNT PLAN (free or paid, status)", plan)
step("ACCOUNT (name, opened)", lambda: {k: v for k, v in boto3.client("account").get_account_information().items() if k in ("AccountName", "AccountCreatedDate")})


def simulate():
    res = iam.simulate_principal_policy(
        PolicySourceArn=arn,
        ActionNames=["s3:ListBucket", "s3:GetObject"],
        ResourceArns=["arn:aws:s3:::usgs-lidar", "arn:aws:s3:::usgs-lidar/*", "arn:aws:s3:::usgs-lidar-public", "arn:aws:s3:::usgs-lidar-public/*"])
    return sorted({(r["EvalActionName"], r["EvalResourceName"].split(":::")[-1], r["EvalDecision"]) for r in res["EvaluationResults"]})


step("AWS'S POLICY SIMULATOR (does this user's policy allow the reads?)", simulate)
step("OUR OWN BUCKETS", lambda: [b["Name"] for b in boto3.client("s3").list_buckets().get("Buckets", [])])
step("S3 PUBLIC ACCESS BLOCK (account)", lambda: boto3.client("s3control", region_name="us-east-1").get_public_access_block(
    AccountId=sts.get_caller_identity()["Account"])["PublicAccessBlockConfiguration"])
