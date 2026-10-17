package sample.c01;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/c01")
public class Controller {
    private Mapper mapper;
    @GetMapping("/records")
    public Object run(@RequestParam String id, Principal principal) {
        return mapper.fetch(id, principal.getName());
    }
}
