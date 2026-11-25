"""
ReportlyUrban — Supabase JWT Authentication & Role Authorization Service
Verifies asymmetric ES256 tokens using the Supabase JWKS endpoint and enforces strict citizen-only access.
"""

from typing import Optional, Dict, Any
from fastapi import Header, HTTPException, status
import jwt
from jwt import PyJWKClient, PyJWTError
import httpx

from app.config import settings

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
