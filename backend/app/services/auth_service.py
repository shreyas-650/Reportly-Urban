"""
ReportlyUrban — Supabase JWT Authentication & Role Authorization Service
Verifies asymmetric ES256 tokens using the Supabase JWKS endpoint and enforces strict
role authorization from the authoritative public.profiles and public.officers tables.
"""

from dataclasses import dataclass
from typing import Optional, Dict, Any
from fastapi import Depends, Header, HTTPException, status
import jwt
from jwt import PyJWKClient, PyJWTError
import httpx

from app.config import settings

VALID_APP_ROLES = ("citizen", "officer", "admin")


@dataclass(frozen=True)
class AuthenticatedActor:
    user_id: str
    role: str
    token: str
    officer_id: Optional[str] = None
    department_id: Optional[str] = None

# Initialize PyJWKClient for live asymmetric ES256 verification
_jwks_url = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json"
_jwks_client: Optional[PyJWKClient] = None

def get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(_jwks_url, cache_jwk_set=True, lifespan=3600)
    return _jwks_client


async def verify_supabase_jwt(token: str) -> Dict[str, Any]:
    """
    Cryptographically verifies an incoming Supabase JWT using the ES256 public key.
    Enforces signature, expiration, issuer (iss), and audience (aud: 'authenticated').
    """
    if not token or not isinstance(token, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token is missing or malformed.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    clean_token = token.strip()
    if clean_token.lower().startswith("bearer "):
        clean_token = clean_token[7:].strip()
    
    try:
        client = get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(clean_token)
        
        expected_issuer = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1"
        payload = jwt.decode(
            clean_token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            issuer=expected_issuer,
            leeway=10,
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": True,
                "verify_iss": True,
            }
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer error=\"invalid_token\", error_description=\"Token expired\""},
        )
    except PyJWTError as jwt_err:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid authentication token: {str(jwt_err)}",
            headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Cryptographic verification of token failed.",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def get_citizen_user(authorization: Optional[str] = Header(None)) -> str:
    """
    FastAPI dependency that validates the Bearer token, queries the user's role from
    the authoritative public.profiles table, and permits only 'citizen'.
    
    Returns the verified citizen UUID string.
    Raises HTTP 401 for invalid/missing token, HTTP 403 for officers/admins.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    payload = await verify_supabase_jwt(authorization)
    user_id = payload.get("sub")
    
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token subject identifier (user ID) is missing.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Query the user's role from public.profiles table using verified token credentials
    clean_token = authorization.strip()
    if clean_token.lower().startswith("bearer "):
        clean_token = clean_token[7:].strip()
    
    rest_url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/profiles?id=eq.{user_id}&select=id,role"
    req_headers = {
        "apikey": settings.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {clean_token}",
        "Accept": "application/json",
    }
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as http_client:
            res = await http_client.get(rest_url, headers=req_headers)
    except Exception as fetch_err:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Unable to reach profile authorization server: {str(fetch_err)}"
        )
    
    if res.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Failed to retrieve profile authorization details for token."
        )
    
    profiles = res.json()
    if not isinstance(profiles, list) or len(profiles) == 0:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Citizen profile not found for this authenticated user."
        )
    
    user_role = profiles[0].get("role", "")
    
    if user_role == "citizen":
        return user_id
    
    if user_role in ("officer", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: Role '{user_role}' cannot utilize citizen AI issue detection. Feature is reserved for citizen grievance reporting."
        )
    
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Access denied: Unauthorized role '{user_role}'."
    )


def _extract_bearer_token(authorization: Optional[str]) -> str:
    if not authorization or not isinstance(authorization, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    clean_token = authorization.strip()
    if clean_token.lower().startswith("bearer "):
        clean_token = clean_token[7:].strip()
    if not clean_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization token is missing.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return clean_token


async def get_authenticated_actor(
    authorization: Optional[str] = Header(None),
) -> AuthenticatedActor:
    """
    Verifies the Supabase ES256 JWT via JWKS, derives user_id strictly from 'sub',
    and looks up the authoritative role from public.profiles (plus active officer
    record when role == 'officer'). Never trusts user_metadata or client-supplied roles.
    """
    clean_token = _extract_bearer_token(authorization)
    payload = await verify_supabase_jwt(clean_token)
    user_id = payload.get("sub")
    if not user_id or not isinstance(user_id, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token subject identifier (user ID) is missing.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    rest_base = settings.SUPABASE_URL.rstrip("/")
    req_headers = {
        "apikey": settings.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {clean_token}",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as http_client:
            profile_res = await http_client.get(
                f"{rest_base}/rest/v1/profiles",
                params={"id": f"eq.{user_id}", "select": "id,role"},
                headers=req_headers,
            )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to verify user authorization status.",
        )

    if profile_res.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Failed to retrieve profile authorization details for token.",
        )

    profiles = profile_res.json()
    if not isinstance(profiles, list) or len(profiles) == 0:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Profile not found for this authenticated user.",
        )

    user_role = str(profiles[0].get("role", "")).strip().lower()
    if user_role not in VALID_APP_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied.",
        )

    officer_id: Optional[str] = None
    department_id: Optional[str] = None
    if user_role == "officer":
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as http_client:
                off_res = await http_client.get(
                    f"{rest_base}/rest/v1/officers",
                    params={
                        "profile_id": f"eq.{user_id}",
                        "is_active": "eq.true",
                        "select": "id,department_id",
                    },
                    headers=req_headers,
                )
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Unable to verify officer authorization status.",
            )

        if off_res.status_code == 200:
            off_rows = off_res.json()
            if isinstance(off_rows, list) and len(off_rows) > 0:
                officer_id = off_rows[0].get("id")
                department_id = off_rows[0].get("department_id")

    return AuthenticatedActor(
        user_id=user_id,
        role=user_role,
        token=clean_token,
        officer_id=officer_id,
        department_id=department_id,
    )


async def require_admin(
    actor: AuthenticatedActor = Depends(get_authenticated_actor),
) -> AuthenticatedActor:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )
    return actor


async def require_active_officer(
    actor: AuthenticatedActor = Depends(get_authenticated_actor),
) -> AuthenticatedActor:
    if actor.role != "officer" or not actor.officer_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Active municipal officer credentials required.",
        )
    return actor


async def require_citizen(
    actor: AuthenticatedActor = Depends(get_authenticated_actor),
) -> AuthenticatedActor:
    if actor.role != "citizen":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Citizen account privileges required.",
        )
    return actor
